import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.ts';
import type { Intent, Merchant } from '../domain/types.ts';
import { toDelivery } from '../domain/map.ts';
import { getStore } from '../db.ts';
import { config } from '../config.ts';
import { num, uid } from '../lib/util.ts';
import { getMerchant } from './merchant.ts';

export type SettlementState = 'NOT_RECONCILED' | 'RECONCILED' | 'EXPIRED' | 'NOT_APPLICABLE';

export interface WebhookPayload {
  event: string;
  deliveryId: string;
  timestamp: number;
  settlementState: SettlementState;
  paymentId: string;
  orderId: string;
  amount: string;
  amountPaise: number;
  utr: string | null;
  status: string;
  expiresAt: number | null;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verifySignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = signPayload(secret, timestamp, body);
  const given = signature.startsWith('sha256=') ? signature : `sha256=${signature}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Enqueue a signed webhook inside the caller's transaction. Delivery happens
 * later from the outbox worker, so a slow merchant endpoint never blocks a
 * payment state change.
 */
export async function enqueueWebhook(
  d: Db,
  merchant: Merchant,
  intent: Intent,
  event: string,
  utr: string | null,
  settlementState: SettlementState,
): Promise<string> {
  const deliveryId = 'wd_' + uid();
  const timestamp = Date.now();
  const payload: WebhookPayload = {
    event,
    deliveryId,
    timestamp,
    settlementState,
    paymentId: intent.id,
    orderId: intent.order_id,
    amount: (intent.amount_paise / 100).toFixed(2),
    amountPaise: intent.amount_paise,
    utr,
    status: intent.status,
    expiresAt: intent.expires_at,
  };
  const body = JSON.stringify(payload);
  const signature = signPayload(merchant.webhook_secret, timestamp, body);
  await d.query(
    `INSERT INTO webhook_deliveries
       (id, intent_id, event, payload, signature, status, attempts, next_attempt_at, created_at)
     VALUES ($1,$2,$3,$4,$5,'PENDING',0,$6,$6)`,
    [deliveryId, intent.id, event, body, signature, timestamp],
  );
  return deliveryId;
}

let workerTimer: NodeJS.Timeout | null = null;
let busy = false;

export function startOutboxWorker(intervalMs = 400): () => void {
  if (workerTimer) return () => {};
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await processDueDeliveries();
    } catch (err) {
      console.error('[outbox]', err);
    } finally {
      busy = false;
    }
  };
  workerTimer = setInterval(() => void tick(), intervalMs);
  workerTimer.unref?.();
  void tick();
  return () => {
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
  };
}

/** Deliver every webhook that is due now. Exported so tests can step the clock. */
export async function processDueDeliveries(now = Date.now()): Promise<number> {
  const d = getStore().db;
  const due = await d.query(
    `SELECT wd.*, m.webhook_url, m.webhook_secret
       FROM webhook_deliveries wd
       JOIN payment_intents i ON i.id = wd.intent_id
       JOIN merchants m ON m.id = i.merchant_id
      WHERE wd.status = 'PENDING' AND wd.next_attempt_at <= $1
      ORDER BY wd.created_at ASC
      LIMIT 20`,
    [now],
  );

  let delivered = 0;
  for (const row of due) {
    const id = String(row.id);
    const body = String(row.payload);
    const attempts = num(row.attempts);
    const timestamp = String(row.created_at);

    try {
      const res = await fetch(String(row.webhook_url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-payproof-event': String(row.event),
          'x-payproof-delivery-id': id,
          'x-payproof-timestamp': timestamp,
          'x-payproof-signature': String(row.signature),
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`endpoint returned HTTP ${res.status}`);
      await d.query(
        `UPDATE webhook_deliveries
            SET status='DELIVERED', attempts=$2, delivered_at=$3, last_error=NULL
          WHERE id=$1`,
        [id, attempts + 1, Date.now()],
      );
      delivered++;
    } catch (err) {
      const nextAttempts = attempts + 1;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      if (nextAttempts >= config.webhookMaxAttempts) {
        await d.query(
          `UPDATE webhook_deliveries
              SET status='FAILED', attempts=$2, last_error=$3
            WHERE id=$1`,
          [id, nextAttempts, message],
        );
      } else {
        const backoff = config.webhookBackoff[Math.min(nextAttempts - 1, config.webhookBackoff.length - 1)];
        await d.query(
          `UPDATE webhook_deliveries
              SET attempts=$2, next_attempt_at=$3, last_error=$4
            WHERE id=$1`,
          [id, nextAttempts, Date.now() + backoff, message],
        );
      }
    }
  }
  return delivered;
}

export async function listDeliveries(d: Db, limit = 12) {
  const rows = await d.query(
    `SELECT wd.*, i.order_id
       FROM webhook_deliveries wd JOIN payment_intents i ON i.id = wd.intent_id
      ORDER BY wd.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ...toDelivery(r), order_id: String(r.order_id) }));
}

export async function deliveriesForIntent(d: Db, intentId: string) {
  const rows = await d.query(
    'SELECT * FROM webhook_deliveries WHERE intent_id = $1 ORDER BY created_at ASC',
    [intentId],
  );
  return rows.map(toDelivery);
}

export async function merchantForDelivery(d: Db, intentId: string): Promise<Merchant> {
  const rows = await d.query(
    `SELECT m.* FROM merchants m JOIN payment_intents i ON i.merchant_id = m.id WHERE i.id = $1`,
    [intentId],
  );
  if (!rows[0]) throw new Error(`No merchant for intent ${intentId}`);
  return getMerchant(d, String(rows[0].id));
}
