import type { Db, Store } from '../db.ts';
import type { Account, Intent, Merchant, Transition } from '../domain/types.ts';
import { toIntent, toTransition } from '../domain/map.ts';
import { recordTransition } from '../domain/lifecycle.ts';
import { ApiError } from '../lib/errors.ts';
import { serialize, uid } from '../lib/util.ts';
import { formatRupees } from '../lib/money.ts';
import { config } from '../config.ts';
import { enqueueWebhook } from './webhooks.ts';
import { getAccount, getAccountForMerchant, getMerchant } from './merchant.ts';

export interface CreateIntentInput {
  orderId: string;
  amountPaise: number;
  note?: string | null;
}

export interface CreateIntentResult {
  intent: Intent;
  created: boolean;
  checkoutUrl: string;
}

function newIntentId(): string {
  return 'pi_' + uid();
}

function checkoutUrlFor(id: string): string {
  return `/checkout/${id}`;
}

export function upiUri(merchant: Merchant, intent: Intent): string {
  const params = new URLSearchParams({
    pa: merchant.vpa,
    pn: merchant.name,
    am: (intent.amount_paise / 100).toFixed(2),
    cu: 'INR',
    tn: intent.note?.slice(0, 40) || `Order ${intent.order_id}`,
    tr: intent.order_id,
  });
  return `upi://pay?${params.toString()}`;
}

/**
 * Create one intent per (merchant, orderId). The database enforces a single
 * live slot per receiving account; if the slot is taken the intent waits in
 * QUEUED and is promoted by the sweeper or when the slot frees up.
 */
export async function createIntent(
  store: Store,
  merchant: Merchant,
  input: CreateIntentInput,
): Promise<CreateIntentResult> {
  return serialize(() =>
    store.tx(async (d) => {
      const existing = await d.query(
        'SELECT * FROM payment_intents WHERE merchant_id = $1 AND order_id = $2',
        [merchant.id, input.orderId],
      );
      if (existing[0]) {
        const intent = toIntent(existing[0]);
        if (intent.amount_paise !== input.amountPaise) {
          throw new ApiError(
            409,
            'ORDER_AMOUNT_MISMATCH',
            `Order ${input.orderId} already exists with a different amount`,
          );
        }
        return { intent, created: false, checkoutUrl: checkoutUrlFor(intent.id) };
      }

      const account = await getAccountForMerchant(d, merchant.id);
      const now = Date.now();
      const live = await d.query(
        `SELECT id FROM payment_intents
          WHERE account_id = $1 AND status IN ('ACTIVE','AWAITING_VERIFICATION') LIMIT 1`,
        [account.id],
      );
      const isActive = live.length === 0;
      const id = newIntentId();
      const rows = await d.query(
        `INSERT INTO payment_intents
           (id, merchant_id, account_id, order_id, amount_paise, note, status,
            created_at, activated_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          id,
          merchant.id,
          account.id,
          input.orderId,
          input.amountPaise,
          input.note ?? null,
          isActive ? 'ACTIVE' : 'QUEUED',
          now,
          isActive ? now : null,
          isActive ? now + config.paymentWindowMs : null,
        ],
      );
      const intent = toIntent(rows[0]);
      await recordTransition(
        d,
        id,
        null,
        intent.status,
        isActive ? 'slot_acquired' : 'waiting_for_slot',
      );
      if (isActive) {
        await enqueueWebhook(d, merchant, intent, 'payment.intent.active', null, 'NOT_APPLICABLE');
      }
      return { intent, created: true, checkoutUrl: checkoutUrlFor(id) };
    }),
  );
}

export async function getIntent(d: Db, id: string): Promise<Intent> {
  const rows = await d.query('SELECT * FROM payment_intents WHERE id = $1', [id]);
  if (!rows[0]) throw new ApiError(404, 'INTENT_NOT_FOUND', `No payment intent ${id}`);
  return toIntent(rows[0]);
}

export async function getIntentForMerchant(d: Db, id: string, merchantId: string): Promise<Intent> {
  const intent = await getIntent(d, id);
  if (intent.merchant_id !== merchantId) {
    throw new ApiError(404, 'INTENT_NOT_FOUND', `No payment intent ${id}`);
  }
  return intent;
}

export async function claimIntent(store: Store, id: string, merchantId?: string): Promise<Intent> {
  return serialize(() =>
    store.tx(async (d) => {
      const intent = await getIntent(d, id);
      if (merchantId && intent.merchant_id !== merchantId) {
        throw new ApiError(404, 'INTENT_NOT_FOUND', `No payment intent ${id}`);
      }
      if (intent.status === 'AWAITING_VERIFICATION') return intent;
      if (intent.status !== 'ACTIVE') {
        throw new ApiError(409, 'INVALID_STATE', `Cannot claim an intent in ${intent.status}`);
      }
      if (intent.expires_at !== null && Date.now() >= intent.expires_at) {
        // The sweeper has not run yet; do not let an elapsed window look claimable.
        throw new ApiError(409, 'PAYMENT_WINDOW_ELAPSED', 'The payment window has elapsed');
      }
      const rows = await d.query(
        `UPDATE payment_intents SET status='AWAITING_VERIFICATION', claimed_at=$2
          WHERE id=$1 AND status='ACTIVE' RETURNING *`,
        [id, Date.now()],
      );
      if (!rows[0]) throw new ApiError(409, 'INVALID_STATE', 'Intent changed while claiming');
      await recordTransition(d, id, 'ACTIVE', 'AWAITING_VERIFICATION', 'customer_claims_paid');
      return toIntent(rows[0]);
    }),
  );
}

export async function cancelIntent(store: Store, id: string, merchantId: string): Promise<Intent> {
  return serialize(() =>
    store.tx(async (d) => {
      const intent = await getIntentForMerchant(d, id, merchantId);
      if (!['QUEUED', 'ACTIVE', 'AWAITING_VERIFICATION'].includes(intent.status)) {
        throw new ApiError(409, 'INVALID_STATE', `Cannot cancel an intent in ${intent.status}`);
      }
      const rows = await d.query(
        `UPDATE payment_intents SET status='CANCELLED'
          WHERE id=$1 AND status IN ('QUEUED','ACTIVE','AWAITING_VERIFICATION') RETURNING *`,
        [id],
      );
      if (!rows[0]) throw new ApiError(409, 'INVALID_STATE', 'Intent changed while cancelling');
      await recordTransition(d, id, intent.status, 'CANCELLED', 'merchant_cancelled');
      const merchant = await getMerchant(d, intent.merchant_id);
      await enqueueWebhook(d, merchant, toIntent(rows[0]), 'payment.cancelled', null, 'NOT_APPLICABLE');
      await promoteNext(d, intent.account_id);
      return toIntent(rows[0]);
    }),
  );
}

/** Promote the oldest QUEUED intent into the account's single live slot. */
export async function promoteNext(d: Db, accountId: string): Promise<Intent | null> {
  // Never promote while a live intent exists. This also protects callers that
  // free a slot by cancelling a QUEUED intent (the slot was never theirs).
  const live = await d.query(
    `SELECT id FROM payment_intents
      WHERE account_id = $1 AND status IN ('ACTIVE','AWAITING_VERIFICATION') LIMIT 1`,
    [accountId],
  );
  if (live[0]) return null;

  const rows = await d.query(
    `SELECT * FROM payment_intents
      WHERE account_id = $1 AND status = 'QUEUED'
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    [accountId],
  );
  if (!rows[0]) return null;
  const now = Date.now();
  const updated = await d.query(
    `UPDATE payment_intents
        SET status='ACTIVE', activated_at=$2, expires_at=$3
      WHERE id=$1 AND status='QUEUED' RETURNING *`,
    [String(rows[0].id), now, now + config.paymentWindowMs],
  );
  if (!updated[0]) return null;
  await recordTransition(d, String(rows[0].id), 'QUEUED', 'ACTIVE', 'slot_promoted');
  const intent = toIntent(updated[0]);
  const merchant = await getMerchant(d, intent.merchant_id);
  await enqueueWebhook(d, merchant, intent, 'payment.intent.active', null, 'NOT_APPLICABLE');
  return intent;
}

/** Expire live intents whose payment window has elapsed, then promote waiters. */
export async function expireDue(store: Store, now = Date.now()): Promise<Intent[]> {
  return serialize(() =>
    store.tx(async (d) => {
      // `|| ''` keeps the column type text for PGlite's parameter binder.
      const due = await d.query(
        `SELECT * FROM payment_intents
          WHERE status IN ('ACTIVE','AWAITING_VERIFICATION')
            AND expires_at IS NOT NULL AND expires_at <= $1
          ORDER BY expires_at ASC`,
        [now],
      );
      const expired: Intent[] = [];
      for (const row of due) {
        const from = String(row.status);
        const updated = await d.query(
          `UPDATE payment_intents SET status='EXPIRED'
            WHERE id=$1 AND status IN ('ACTIVE','AWAITING_VERIFICATION') RETURNING *`,
          [String(row.id)],
        );
        if (!updated[0]) continue;
        await recordTransition(d, String(row.id), from, 'EXPIRED', 'payment_window_elapsed');
        const intent = toIntent(updated[0]);
        const merchant = await getMerchant(d, intent.merchant_id);
        await enqueueWebhook(d, merchant, intent, 'payment.expired', null, 'EXPIRED');
        expired.push(intent);
        await promoteNext(d, intent.account_id);
      }
      return expired;
    }),
  );
}

export interface IntentDetail {
  intent: Intent;
  account: Account;
  merchant: Merchant;
  transitions: Transition[];
  alert: {
    id: string;
    source: string;
    utr: string;
    amount_paise: number;
    received_at: number;
    raw: string;
  } | null;
  deliveries: Array<{
    id: string;
    event: string;
    status: string;
    attempts: number;
    last_error: string | null;
    signature: string;
    payload: string;
  }>;
}

export async function intentDetail(d: Db, id: string, merchantId?: string): Promise<IntentDetail> {
  const intent = merchantId ? await getIntentForMerchant(d, id, merchantId) : await getIntent(d, id);
  const merchant = await getMerchant(d, intent.merchant_id);
  const account = await getAccount(d, intent.account_id);
  const transitions = (
    await d.query(
      'SELECT * FROM intent_transitions WHERE intent_id = $1 ORDER BY created_at ASC, id ASC',
      [id],
    )
  ).map(toTransition);
  const alerts = await d.query(
    'SELECT * FROM alerts WHERE intent_id = $1 ORDER BY received_at ASC LIMIT 1',
    [id],
  );
  const deliveries = await d.query(
    'SELECT * FROM webhook_deliveries WHERE intent_id = $1 ORDER BY created_at ASC',
    [id],
  );
  return {
    intent,
    account,
    merchant,
    transitions,
    alert: alerts[0]
      ? {
          id: String(alerts[0].id),
          source: String(alerts[0].source),
          utr: String(alerts[0].utr),
          amount_paise: Number(alerts[0].amount_paise),
          received_at: Number(alerts[0].received_at),
          raw: String(alerts[0].raw),
        }
      : null,
    deliveries: deliveries.map((r) => ({
      id: String(r.id),
      event: String(r.event),
      status: String(r.status),
      attempts: Number(r.attempts),
      last_error: (r.last_error as string | null) ?? null,
      signature: String(r.signature),
      payload: String(r.payload),
    })),
  };
}

export async function listIntents(d: Db, merchantId: string, limit = 20) {
  const rows = await d.query(
    'SELECT * FROM payment_intents WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2',
    [merchantId, limit],
  );
  return rows.map(toIntent);
}

export interface DashboardStats {
  total: number;
  byStatus: Record<string, number>;
  awaitingReconciliation: number;
  awaitingValuePaise: number;
  openReviews: number;
  pendingDeliveries: number;
  failedDeliveries: number;
}

export async function dashboardStats(d: Db, merchantId: string): Promise<DashboardStats> {
  const statusRows = await d.query(
    'SELECT status, COUNT(*)::int AS n FROM payment_intents WHERE merchant_id = $1 GROUP BY status',
    [merchantId],
  );
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of statusRows) {
    const n = Number(r.n);
    byStatus[String(r.status)] = n;
    total += n;
  }
  const observed = await d.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_paise),0)::bigint AS v
       FROM payment_intents WHERE merchant_id = $1 AND status = 'OBSERVED'`,
    [merchantId],
  );
  const reviews = await d.query(
    `SELECT COUNT(*)::int AS n FROM alert_reviews r
       JOIN alerts a ON a.id = r.alert_id
       JOIN accounts ac ON ac.id = a.account_id
      WHERE r.status = 'OPEN' AND ac.merchant_id = $1`,
    [merchantId],
  );
  const deliveries = await d.query(
    `SELECT wd.status AS status, COUNT(*)::int AS n FROM webhook_deliveries wd
       JOIN payment_intents i ON i.id = wd.intent_id
      WHERE i.merchant_id = $1 AND wd.status IN ('PENDING','FAILED') GROUP BY wd.status`,
    [merchantId],
  );
  const pending = deliveries.find((r) => String(r.status) === 'PENDING');
  const failed = deliveries.find((r) => String(r.status) === 'FAILED');
  return {
    total,
    byStatus,
    awaitingReconciliation: Number(observed[0]?.n ?? 0),
    awaitingValuePaise: Number(observed[0]?.v ?? 0),
    openReviews: Number(reviews[0]?.n ?? 0),
    pendingDeliveries: Number(pending?.n ?? 0),
    failedDeliveries: Number(failed?.n ?? 0),
  };
}

export function remainingMs(intent: Intent, now = Date.now()): number {
  if (intent.status !== 'ACTIVE' || !intent.expires_at) return 0;
  return Math.max(0, intent.expires_at - now);
}

export { formatRupees };
