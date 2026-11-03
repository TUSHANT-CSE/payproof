import type { Db } from '../db.ts';
import type { Account, Merchant } from '../domain/types.ts';
import { toMerchant } from '../domain/map.ts';
import { ApiError } from '../lib/errors.ts';

export async function getMerchantByKey(d: Db, apiKey: string): Promise<Merchant | null> {
  const rows = await d.query('SELECT * FROM merchants WHERE api_key = $1', [apiKey]);
  return rows[0] ? toMerchant(rows[0]) : null;
}

export async function getMerchant(d: Db, id: string): Promise<Merchant> {
  const rows = await d.query('SELECT * FROM merchants WHERE id = $1', [id]);
  if (!rows[0]) throw new ApiError(404, 'MERCHANT_NOT_FOUND', `No merchant ${id}`);
  return toMerchant(rows[0]);
}

export async function getMerchantForIntent(d: Db, intentId: string): Promise<Merchant> {
  const rows = await d.query(
    `SELECT m.* FROM merchants m
     JOIN payment_intents i ON i.merchant_id = m.id
     WHERE i.id = $1`,
    [intentId],
  );
  if (!rows[0]) throw new ApiError(404, 'MERCHANT_NOT_FOUND', `No merchant for intent ${intentId}`);
  return toMerchant(rows[0]);
}

export async function getDemoMerchant(d: Db): Promise<Merchant> {
  const rows = await d.query("SELECT * FROM merchants WHERE id = 'm_demo'");
  if (!rows[0]) throw new Error('Demo merchant missing — database was not seeded');
  return toMerchant(rows[0]);
}

/** Keep the demo merchant pointed at this instance's /webhook-sink. */
export async function ensureDemoWebhookTarget(d: Db, url: string): Promise<void> {
  await d.query("UPDATE merchants SET webhook_url = $1 WHERE id = 'm_demo'", [url]);
}

export async function getAccountForMerchant(d: Db, merchantId: string): Promise<Account> {
  const rows = await d.query(
    'SELECT * FROM accounts WHERE merchant_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1',
    [merchantId],
  );
  if (!rows[0]) throw new ApiError(422, 'NO_RECEIVING_ACCOUNT', 'Merchant has no receiving account');
  const r = rows[0];
  return {
    id: String(r.id),
    merchant_id: String(r.merchant_id),
    vpa: String(r.vpa),
    label: String(r.label),
    created_at: Number(r.created_at),
  };
}

export async function getAccount(d: Db, id: string): Promise<Account> {
  const rows = await d.query('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!rows[0]) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', `No account ${id}`);
  const r = rows[0];
  return {
    id: String(r.id),
    merchant_id: String(r.merchant_id),
    vpa: String(r.vpa),
    label: String(r.label),
    created_at: Number(r.created_at),
  };
}
