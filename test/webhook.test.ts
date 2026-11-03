/**
 * Outbox delivery: HMAC signature, success, retry and permanent failure.
 * A real local HTTP server receives the webhooks.
 */
process.env.DB_DRIVER = 'pglite';
process.env.PGLITE_DIR = ':memory:';
process.env.API_KEY = 'pk_webhook_test';
process.env.PAYMENT_WINDOW_MS = '600000';
process.env.WEBHOOK_MAX_ATTEMPTS = '2';
process.env.WEBHOOK_BACKOFF_MS = '10';

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { initDb, closeDb, getStore } = await import('../src/db.ts');
const { createApp } = await import('../src/app.ts');
const { processDueDeliveries, signPayload, verifySignature } = await import('../src/services/webhooks.ts');

const KEY = 'pk_webhook_test';
const store = await initDb();
const app = await createApp();

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const received: Received[] = [];
let failHits = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push({ path: req.url ?? '', headers: req.headers, body });
    if ((req.url ?? '').startsWith('/fail')) {
      failHits++;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

const secretRows = await store.db.query<{ webhook_secret: string }>(
  "SELECT webhook_secret FROM merchants WHERE id = 'm_demo'",
);
const secret = String(secretRows[0].webhook_secret);

async function setTarget(path: string): Promise<void> {
  await store.db.query("UPDATE merchants SET webhook_url = $1 WHERE id = 'm_demo'", [
    `http://127.0.0.1:${port}${path}`,
  ]);
}

async function api(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { 'x-api-key': KEY },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json() as any };
}

after(async () => {
  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

test('rejects malformed signatures', () => {
  const body = '{"event":"payment.observed"}';
  const ts = Date.now();
  const valid = signPayload(secret, ts, body);
  assert.equal(verifySignature(secret, ts, body, valid), true);
  assert.equal(verifySignature(secret, ts, body, 'sha256=deadbeef'), false);
  assert.equal(verifySignature(secret, ts, body, 'not-even-a-hash'), false);
  assert.equal(verifySignature('other-secret', ts, body, valid), false);
  assert.equal(verifySignature(secret, ts + 1, body, valid), false, 'timestamp is signed');
});

test('delivers signed webhooks and records them as DELIVERED', async () => {
  await setTarget('/ok');
  const created = await api('POST', '/api/intents', { orderId: 'ORD-W1', amountPaise: 12_345 });
  assert.equal(created.status, 201);
  const intentId = created.body.intent.id;

  const alert = await api('POST', '/api/simulator/alert', {
    amountPaise: 12_345,
    utr: '444444444444',
    source: 'sms',
  });
  assert.equal(alert.body.matched.id, intentId);

  const delivered = await processDueDeliveries();
  assert.ok(delivered >= 2, `expected intent.active + payment.observed, delivered ${delivered}`);

  const observed = received.find((r) => r.path === '/ok' && JSON.parse(r.body).event === 'payment.observed');
  assert.ok(observed, 'observed webhook reached the endpoint');
  const payload = JSON.parse(observed.body);
  assert.equal(payload.amountPaise, 12_345);
  assert.equal(payload.amount, '123.45');
  assert.equal(payload.settlementState, 'NOT_RECONCILED');
  assert.equal(payload.utr, '444444444444');

  const timestamp = Number(observed.headers['x-payproof-timestamp']);
  assert.equal(timestamp, payload.timestamp);
  assert.equal(
    verifySignature(secret, timestamp, observed.body, String(observed.headers['x-payproof-signature'])),
    true,
  );
  assert.equal(observed.headers['x-payproof-event'], 'payment.observed');

  const rows = await store.db.query<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM webhook_deliveries WHERE intent_id = $1',
    [intentId],
  );
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.status === 'DELIVERED'), 'all deliveries acknowledged');
  assert.ok(rows.every((r) => Number(r.attempts) === 1));
});

test('retries failures with backoff and gives up at the configured limit', async () => {
  await setTarget('/fail');
  const created = await api('POST', '/api/intents', { orderId: 'ORD-W2', amountPaise: 22_200 });
  const intentId = created.body.intent.id;
  await api('POST', '/api/simulator/alert', { amountPaise: 22_200, utr: '555555555555' });

  await processDueDeliveries();
  let rows = await store.db.query<{
    id: string;
    status: string;
    attempts: number;
    event: string;
    last_error: string | null;
  }>(
    'SELECT id, status, attempts, event, last_error FROM webhook_deliveries WHERE intent_id = $1 ORDER BY created_at',
    [intentId],
  );
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.status === 'PENDING'));
  assert.ok(rows.every((r) => Number(r.attempts) === 1));

  await new Promise((resolve) => setTimeout(resolve, 40));
  await processDueDeliveries();
  rows = await store.db.query<{
    id: string;
    status: string;
    attempts: number;
    event: string;
    last_error: string | null;
  }>(
    'SELECT id, status, attempts, event, last_error FROM webhook_deliveries WHERE intent_id = $1 ORDER BY created_at',
    [intentId],
  );
  assert.ok(rows.every((r) => r.status === 'FAILED'));
  assert.ok(rows.every((r) => Number(r.attempts) === 2));
  assert.ok(rows.some((r) => String(r.last_error).includes('HTTP 500')));
  assert.ok(failHits >= 4, 'endpoint was hit once per delivery attempt');
});
