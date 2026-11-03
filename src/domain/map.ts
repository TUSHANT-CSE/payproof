import type { AlertRow, Delivery, Intent, Merchant, ReviewRow, Transition } from './types.ts';
import { num, numOrNull } from '../lib/util.ts';

type Row = Record<string, unknown>;

export function toIntent(r: Row): Intent {
  return {
    id: String(r.id),
    merchant_id: String(r.merchant_id),
    account_id: String(r.account_id),
    order_id: String(r.order_id),
    amount_paise: num(r.amount_paise),
    note: (r.note as string | null) ?? null,
    status: r.status as Intent['status'],
    created_at: num(r.created_at),
    activated_at: numOrNull(r.activated_at),
    expires_at: numOrNull(r.expires_at),
    claimed_at: numOrNull(r.claimed_at),
    observed_at: numOrNull(r.observed_at),
    reconciled_at: numOrNull(r.reconciled_at),
  };
}

export function toAlert(r: Row): AlertRow {
  return {
    id: String(r.id),
    account_id: String(r.account_id),
    source: String(r.source),
    raw: String(r.raw),
    amount_paise: num(r.amount_paise),
    utr: String(r.utr),
    received_at: num(r.received_at),
    intent_id: (r.intent_id as string | null) ?? null,
    created_at: num(r.created_at),
  };
}

export function toTransition(r: Row): Transition {
  return {
    id: String(r.id),
    intent_id: String(r.intent_id),
    from_status: (r.from_status as string | null) ?? null,
    to_status: String(r.to_status),
    reason: String(r.reason),
    created_at: num(r.created_at),
  };
}

export function toDelivery(r: Row): Delivery {
  return {
    id: String(r.id),
    intent_id: String(r.intent_id),
    event: String(r.event),
    payload: String(r.payload),
    signature: String(r.signature),
    status: r.status as Delivery['status'],
    attempts: num(r.attempts),
    next_attempt_at: num(r.next_attempt_at),
    last_error: (r.last_error as string | null) ?? null,
    delivered_at: numOrNull(r.delivered_at),
    created_at: num(r.created_at),
  };
}

export function toReview(r: Row): ReviewRow {
  return {
    id: String(r.id),
    alert_id: String(r.alert_id),
    reason: String(r.reason),
    suggested_intent_id: (r.suggested_intent_id as string | null) ?? null,
    status: String(r.status),
    created_at: num(r.created_at),
    utr: r.utr === undefined ? undefined : String(r.utr),
    amount_paise: r.amount_paise === undefined ? undefined : num(r.amount_paise),
    source: r.source === undefined ? undefined : String(r.source),
    received_at: r.received_at === undefined ? undefined : num(r.received_at),
  };
}

export function toMerchant(r: Row): Merchant {
  return {
    id: String(r.id),
    name: String(r.name),
    vpa: String(r.vpa),
    api_key: String(r.api_key),
    webhook_url: String(r.webhook_url),
    webhook_secret: String(r.webhook_secret),
    created_at: num(r.created_at),
  };
}
