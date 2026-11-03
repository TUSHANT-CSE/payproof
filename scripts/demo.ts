/**
 * One-command, self-contained demo.
 *   npm run demo
 * Boots PayProof on :4100 with a fresh demo database and walks the full
 * evidence → observation → reconciliation lifecycle against its own API.
 * The server stays up so you can inspect the dashboard afterwards.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.DEMO_PORT ?? 4100);
const demoDir = fileURLToPath(new URL('../data/demo-pgdata', import.meta.url));
const useLocalDemoDb = !process.env.PGLITE_DIR;
if (useLocalDemoDb) process.env.PGLITE_DIR = demoDir;
process.env.PORT = String(port);
process.env.WEBHOOK_TARGET = `http://127.0.0.1:${port}/webhook-sink`;
process.env.DB_DRIVER ??= 'pglite';
process.env.PAYMENT_WINDOW_MS ??= '300000';

if (useLocalDemoDb) fs.rmSync(demoDir, { recursive: true, force: true });

const { config } = await import('../src/config.ts');
const { initDb, closeDb, getStore } = await import('../src/db.ts');
const { createApp } = await import('../src/app.ts');
const { ensureDemoWebhookTarget } = await import('../src/services/merchant.ts');
const { startSweeper } = await import('../src/services/sweeper.ts');
const { startOutboxWorker, processDueDeliveries } = await import('../src/services/webhooks.ts');

const base = `http://127.0.0.1:${port}`;
const KEY = config.apiKey;
const UTR = '412345678901';

function line(): void {
  console.log('-'.repeat(66));
}

function step(n: number, total: number, text: string): void {
  console.log(`\n[${n}/${total}] ${text}`);
}

async function call<T = any>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* html/text response */
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, json: json as T };
}

const store = await initDb();
await ensureDemoWebhookTarget(store.db, config.webhookTarget);

const app = await createApp();
const stopSweeper = startSweeper();
const stopOutbox = startOutboxWorker();

try {
  await app.listen({ port, host: '127.0.0.1' });
} catch (err) {
  console.error('Could not start the demo server. Is port ' + port + ' already in use?');
  console.error(err);
  await closeDb();
  process.exit(1);
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`\n[shutdown] ${signal}`);
  stopOutbox();
  stopSweeper();
  try {
    await app.close();
    await closeDb();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

console.log('');
line();
console.log('  payproof demo · evidence is not truth');
line();
console.log(`  dashboard  ${base}/`);
console.log(`  database   ${config.dbDriver} · ${config.pgliteDir}`);
console.log(`  api key    ${KEY}`);

try {
  const TOTAL = 6;

  step(1, TOTAL, 'Create an intent for ORD-1001, INR 249.00');
  const created = await call('POST', '/api/intents', {
    orderId: 'ORD-1001',
    amountPaise: 24_900,
    note: 'Demo order',
  });
  const intentId: string = created.json.intent.id;
  console.log(`      → ${created.json.intent.status} · ${base}${created.json.checkoutUrl}`);
  console.log(`      → window closes ${new Date(created.json.intent.expires_at).toLocaleTimeString('en-IN', { hour12: false })}`);

  step(2, TOTAL, 'Send an alert that is one paise short');
  const near = await call('POST', '/api/simulator/alert', {
    amountPaise: 24_899,
    utr: '999999999991',
    source: 'sms',
  });
  console.log(`      → matched: ${near.json.matched ? 'YES (bug!)' : 'none'} · review: ${near.json.review?.reason ?? '—'}`);
  const detailStillActive = await call('GET', `/api/intents/${intentId}`);
  console.log(`      → intent is still ${detailStillActive.json.intent.status} (evidence did not change state)`);
  await call('POST', `/api/review/${near.json.review.id}/resolve`, { action: 'dismiss' });

  step(3, TOTAL, 'Send the exact in-window alert');
  const alert = await call('POST', '/api/simulator/alert', {
    amountPaise: 24_900,
    utr: UTR,
    source: 'sms',
    raw: `HDFC Bank: INR 249.00 credited to demo@payproof. UTR ${UTR}`,
  });
  console.log(`      → matched ${alert.json.matched.orderId} · status ${alert.json.matched.status}`);
  console.log('      → webhook event payment.observed with settlementState NOT_RECONCILED');

  step(4, TOTAL, 'Drain the webhook outbox to the local sink');
  const delivered = await processDueDeliveries();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const deliveries = await getStore().db.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM webhook_deliveries GROUP BY status`,
  );
  console.log(`      → ${delivered} delivered now · outbox: ${deliveries.map((d) => `${d.status}=${d.n}`).join(', ')}`);

  step(5, TOTAL, 'Import the bank statement for the same UTR and amount');
  const imported = await call('POST', '/api/reconciliation/import', {
    csv: `utr,amount_rupees,date\n${UTR},249.00,2026-11-03`,
  });
  console.log(
    `      → imported ${imported.json.imported} · reconciled ${imported.json.reconciled} · unmatched ${imported.json.unmatched}`,
  );
  await processDueDeliveries();
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log('      → payment.reconciled webhook delivered with settlementState RECONCILED');

  step(6, TOTAL, 'Verify the final, only-true-success state');
  const detail = await call('GET', `/api/intents/${intentId}`);
  const report = await call('GET', '/api/reconciliation/report');
  const ledger = await getStore().db.query<{ direction: string; amount_paise: number }>(
    'SELECT direction, amount_paise FROM ledger_entries WHERE intent_id = $1 ORDER BY direction',
    [intentId],
  );
  const debit = ledger.find((l) => l.direction === 'DEBIT');
  const credit = ledger.find((l) => l.direction === 'CREDIT');
  const deliveryRows = await getStore().db.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM webhook_deliveries GROUP BY status`,
  );
  const pending = deliveryRows.find((d) => d.status === 'PENDING')?.n ?? 0;

  const dash = await fetch(base + '/');
  const html = await dash.text();
  const sinkRendered = html.includes('payment.reconciled') && html.includes('sig ✓');

  line();
  console.log('  RESULT');
  console.log(`  intent                  ${detail.json.intent.status}`);
  console.log(`  transitions             ${detail.json.transitions.map((t: { to_status: string }) => t.to_status).join(' → ')}`);
  console.log(`  ledger                  DEBIT ${(Number(debit?.amount_paise ?? 0) / 100).toFixed(2)} / CREDIT ${(Number(credit?.amount_paise ?? 0) / 100).toFixed(2)}`);
  console.log(`  reconciled (report)     ${report.json.reconciledCount} payment(s), INR ${(report.json.reconciledValuePaise / 100).toFixed(2)}`);
  console.log(`  webhook outbox          ${pending === 0 ? 'all delivered' : pending + ' pending'}${sinkRendered ? ' · signed and received' : ''}`);
  console.log(`  review queue            ${report.json.unmatchedLines.length} unmatched statement line(s)`);
  line();
  console.log('');
  console.log('  Demo complete. The server is still running:');
  console.log(`    dashboard  ${base}/`);
  console.log(`    checkout   ${base}/checkout/${intentId}`);
  console.log('');
  console.log('  Try it in the UI: create another intent, send a late alert,');
  console.log('  watch it land in the review queue instead of becoming success.');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
} catch (err) {
  console.error('\n[demo] failed:', err instanceof Error ? err.message : err);
  await shutdown('demo-error');
}
