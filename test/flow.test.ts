/**
 * End-to-end lifecycle through the HTTP API with an in-memory Postgres.
 * Env must be set before importing config/db.
 */
process.env.DB_DRIVER = 'pglite';
process.env.PGLITE_DIR = ':memory:';
process.env.API_KEY = 'pk_flow_test';
process.env.PAYMENT_WINDOW_MS = '600000';
process.env.LATE_GRACE_MS = '1800000';

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const { initDb, closeDb, getStore } = await import('../src/db.ts');
const { createApp } = await import('../src/app.ts');
const { expireDue } = await import('../src/services/intents.ts');

const KEY = 'pk_flow_test';
const store = await initDb();
const app = await createApp();

after(async () => {
  await app.close();
  await closeDb();
});

async function api(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  key: string | null = KEY,
): Promise<{ status: number; body: any }> {
  const res = await app.inject({
    method,
    url,
    headers: key ? { 'x-api-key': key } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json() };
}

let intentA = '';
let intentB = '';
let intentC = '';
let reviewId = '';

test('health is public', async () => {
  const r = await api('GET', '/health', undefined, null);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('auth is required for the collection API', async () => {
  const r = await api('GET', '/api/intents', undefined, null);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'UNAUTHORIZED');
});

test('first intent takes the live slot; second waits in FIFO', async () => {
  const first = await api('POST', '/api/intents', { orderId: 'ORD-A', amountPaise: 25_000 });
  assert.equal(first.status, 201);
  intentA = first.body.intent.id;
  assert.equal(first.body.intent.status, 'ACTIVE');
  assert.equal(first.body.checkoutUrl, `/checkout/${intentA}`);

  const second = await api('POST', '/api/intents', { orderId: 'ORD-B', amountPaise: 25_000 });
  assert.equal(second.status, 201);
  intentB = second.body.intent.id;
  assert.equal(second.body.intent.status, 'QUEUED');

  const pub = await api('GET', `/api/public/intents/${intentA}`, undefined, null);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.status, 'ACTIVE');
  assert.equal(pub.body.amount, '250.00');
  assert.equal(typeof pub.body.serverTime, 'number');
});

test('order ids are idempotent, but the amount is part of the key', async () => {
  const again = await api('POST', '/api/intents', { orderId: 'ORD-A', amountPaise: 25_000 });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.intent.id, intentA);

  const mismatch = await api('POST', '/api/intents', { orderId: 'ORD-A', amountPaise: 26_000 });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error, 'ORDER_AMOUNT_MISMATCH');
});

test('a wrong-amount alert becomes a review, never a match', async () => {
  const r = await api('POST', '/api/simulator/alert', {
    amountPaise: 24_999,
    utr: '111111111111',
    source: 'sms',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.matched, null);
  assert.equal(r.body.review.reason, 'NO_ELIGIBLE_INTENT');

  const detail = await api('GET', `/api/intents/${intentA}`);
  assert.equal(detail.body.intent.status, 'ACTIVE', 'evidence alone must not change the intent');
});

test('an exact in-window alert moves the intent to OBSERVED and promotes the waiter', async () => {
  const r = await api('POST', '/api/simulator/alert', {
    amountPaise: 25_000,
    utr: '222222222222',
    source: 'sms',
    raw: 'HDFC Bank: Rs.250.00 credited. UTR 222222222222',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.matched.id, intentA);
  assert.equal(r.body.matched.status, 'OBSERVED');
  assert.equal(r.body.review, null);

  const a = await api('GET', `/api/intents/${intentA}`);
  assert.equal(a.body.intent.status, 'OBSERVED');
  assert.equal(a.body.alert.utr, '222222222222');
  assert.ok(
    a.body.deliveries.some(
      (d: { event: string }) => d.event === 'payment.observed',
    ),
  );
  assert.ok(
    a.body.transitions.some((t: { to_status: string; reason: string }) => t.to_status === 'OBSERVED' && t.reason === 'bank_alert:sms'),
  );

  const b = await api('GET', `/api/intents/${intentB}`);
  assert.equal(b.body.intent.status, 'ACTIVE', 'queued intent is promoted into the slot');
});

test('duplicate UTRs are ignored idempotently', async () => {
  const dup = await api('POST', '/api/simulator/alert', {
    amountPaise: 25_000,
    utr: '222222222222',
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.matched, null);

  const a = await api('GET', `/api/intents/${intentA}`);
  assert.equal(a.body.intent.status, 'OBSERVED', 'replay must not double-observe');
  assert.equal(
    a.body.deliveries.filter((d: { event: string }) => d.event === 'payment.observed').length,
    1,
  );
});

test('claiming requires a live ACTIVE intent', async () => {
  const claimB = await api('POST', `/api/intents/${intentB}/claim`);
  assert.equal(claimB.status, 200);
  assert.equal(claimB.body.intent.status, 'AWAITING_VERIFICATION');

  const again = await api('POST', `/api/intents/${intentB}/claim`);
  assert.equal(again.status, 200, 'claim is idempotent');
  assert.equal(again.body.intent.status, 'AWAITING_VERIFICATION');

  const observed = await api('POST', `/api/intents/${intentA}/claim`);
  assert.equal(observed.status, 409);
  assert.equal(observed.body.error, 'INVALID_STATE');
});

test('statement import is the only path to RECONCILED', async () => {
  const csv = [
    'utr,amount_rupees,date',
    '222222222222,250.00,2026-11-03',
    '999999999999,123.45,2026-11-03',
  ].join('\n');
  const imported = await api('POST', '/api/reconciliation/import', { csv });
  assert.equal(imported.status, 200);
  assert.deepEqual(
    {
      total: imported.body.total,
      imported: imported.body.imported,
      duplicates: imported.body.duplicates,
      reconciled: imported.body.reconciled,
      unmatched: imported.body.unmatched,
      amount: imported.body.amountReconciledPaise,
    },
    { total: 2, imported: 2, duplicates: 0, reconciled: 1, unmatched: 1, amount: 25_000 },
  );

  const a = await api('GET', `/api/intents/${intentA}`);
  assert.equal(a.body.intent.status, 'RECONCILED');
  assert.ok(
    a.body.transitions.some((t: { to_status: string; reason: string }) => t.to_status === 'RECONCILED' && t.reason === 'bank_statement_match'),
  );
  assert.ok(a.body.deliveries.some((d: { event: string }) => d.event === 'payment.reconciled'));

  const ledger = await getStore().db.query<{ direction: string; amount_paise: number }>(
    'SELECT direction, amount_paise FROM ledger_entries WHERE intent_id = $1 ORDER BY direction',
    [intentA],
  );
  assert.equal(ledger.length, 2, 'double-entry: one debit, one credit');
  assert.deepEqual(ledger.map((l) => l.direction), ['CREDIT', 'DEBIT']);
  assert.ok(ledger.every((l) => Number(l.amount_paise) === 25_000));

  const again = await api('POST', '/api/reconciliation/import', { csv });
  assert.equal(again.body.duplicates, 2);
  assert.equal(again.body.reconciled, 0, 're-import is idempotent');

  const report = await api('GET', '/api/reconciliation/report');
  assert.equal(report.body.reconciledCount, 1);
  assert.equal(report.body.reconciledValuePaise, 25_000);
  assert.equal(report.body.unmatchedLines.length, 1);
  assert.equal(report.body.unmatchedLines[0].utr, '999999999999');
  assert.equal(report.body.observedAwaitingStatement.length, 0);
  const debit = report.body.ledger.find((l: { direction: string }) => l.direction === 'DEBIT');
  const credit = report.body.ledger.find((l: { direction: string }) => l.direction === 'CREDIT');
  assert.equal(debit.total_paise, 25_000);
  assert.equal(credit.total_paise, 25_000);
});

test('expiry frees the slot and a late alert goes to review, not to the intent', async () => {
  const c = await api('POST', '/api/intents', { orderId: 'ORD-C', amountPaise: 11_100 });
  assert.equal(c.status, 201);
  intentC = c.body.intent.id;
  assert.equal(c.body.intent.status, 'QUEUED', 'B still holds the slot');

  const firstExpiry = await expireDue(store, Date.now() + 700_000);
  assert.ok(firstExpiry.some((i) => i.id === intentB), 'B expired');

  const b = await api('GET', `/api/intents/${intentB}`);
  assert.equal(b.body.intent.status, 'EXPIRED');
  const cActive = await api('GET', `/api/intents/${intentC}`);
  assert.equal(cActive.body.intent.status, 'ACTIVE', 'C was promoted');

  const secondExpiry = await expireDue(store, Date.now() + 1_400_000);
  assert.ok(secondExpiry.some((i) => i.id === intentC), 'C expired');

  const late = await api('POST', '/api/simulator/alert', {
    amountPaise: 11_100,
    utr: '333333333333',
    source: 'gmail',
    receivedAt: Date.now() + 1_500_000,
  });
  assert.equal(late.status, 201);
  assert.equal(late.body.matched, null, 'late alerts never auto-match');
  assert.equal(late.body.review.reason, 'POSSIBLE_LATE_MATCH');
  assert.equal(late.body.review.suggestedIntentId, intentC);
  reviewId = late.body.review.id;

  const cAfter = await api('GET', `/api/intents/${intentC}`);
  assert.equal(cAfter.body.intent.status, 'EXPIRED');
});

test('operator can link a late alert, then reconcile it', async () => {
  const resolved = await api('POST', `/api/review/${reviewId}/resolve`, {
    action: 'link',
    intentId: intentC,
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.review.status, 'RESOLVED');

  const c = await api('GET', `/api/intents/${intentC}`);
  assert.equal(c.body.intent.status, 'OBSERVED');
  assert.ok(
    c.body.transitions.some((t: { reason: string }) => t.reason === 'manual_review_late_match'),
  );

  const imported = await api('POST', '/api/reconciliation/import', {
    csv: 'utr,amount_rupees,date\n333333333333,111.00,2026-11-03',
  });
  assert.equal(imported.body.reconciled, 1);

  const report = await api('GET', '/api/reconciliation/report');
  assert.equal(report.body.reconciledCount, 2);
  assert.equal(report.body.reconciledValuePaise, 36_100);
});

test('validation and validation errors are explicit', async () => {
  const noOrder = await api('POST', '/api/intents', { amountPaise: 100 });
  assert.equal(noOrder.status, 400);
  assert.equal(noOrder.body.error, 'VALIDATION_ERROR');

  const noAmount = await api('POST', '/api/intents', { orderId: 'ORD-X' });
  assert.equal(noAmount.status, 422);
  assert.equal(noAmount.body.error, 'INVALID_AMOUNT');

  const badUtr = await api('POST', '/api/simulator/alert', { amountPaise: 100, utr: '!!' });
  assert.equal(badUtr.status, 400);

  const badCsv = await api('POST', '/api/reconciliation/import', {
    csv: 'utr,amount_rupees,date\nNOT_A_UTR,ten,2026-11-03',
  });
  assert.equal(badCsv.status, 422);
  assert.equal(badCsv.body.error, 'INVALID_STATEMENT');

  const claimReconciled = await api('POST', `/api/intents/${intentA}/claim`);
  assert.equal(claimReconciled.status, 409);
});

test('cancelling a queued intent never steals the live slot', async () => {
  const active = await api('POST', '/api/intents', { orderId: 'ORD-D', amountPaise: 5_000 });
  assert.equal(active.body.intent.status, 'ACTIVE');
  const queued = await api('POST', '/api/intents', { orderId: 'ORD-E', amountPaise: 6_000 });
  assert.equal(queued.body.intent.status, 'QUEUED');

  const cancelQueued = await api('POST', `/api/intents/${queued.body.intent.id}/cancel`);
  assert.equal(cancelQueued.status, 200);
  assert.equal(cancelQueued.body.intent.status, 'CANCELLED');

  const stillActive = await api('GET', `/api/intents/${active.body.intent.id}`);
  assert.equal(stillActive.body.intent.status, 'ACTIVE', 'D keeps the slot');

  const cancelActive = await api('POST', `/api/intents/${active.body.intent.id}/cancel`);
  assert.equal(cancelActive.body.intent.status, 'CANCELLED');
});

test('claim is refused once the wall-clock window has elapsed', async () => {
  const created = await api('POST', '/api/intents', { orderId: 'ORD-F', amountPaise: 7_000 });
  const id = created.body.intent.id;
  await getStore().db.query('UPDATE payment_intents SET expires_at = $2 WHERE id = $1', [
    id,
    Date.now() - 1,
  ]);
  const claim = await api('POST', `/api/intents/${id}/claim`);
  assert.equal(claim.status, 409);
  assert.equal(claim.body.error, 'PAYMENT_WINDOW_ELAPSED');

  const expired = await expireDue(store, Date.now());
  assert.ok(expired.some((i) => i.id === id));
});

test('unknown intent is a 404', async () => {
  const r = await api('GET', '/api/intents/pi_does_not_exist');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'INTENT_NOT_FOUND');
});
