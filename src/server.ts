import { config } from './config.ts';
import { closeDb, initDb } from './db.ts';
import { createApp } from './app.ts';
import { ensureDemoWebhookTarget } from './services/merchant.ts';
import { startSweeper } from './services/sweeper.ts';
import { startOutboxWorker } from './services/webhooks.ts';

const store = await initDb();
await ensureDemoWebhookTarget(store.db, config.webhookTarget);

const app = await createApp();
const stopSweeper = startSweeper();
const stopOutbox = startOutboxWorker();

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  console.error('[boot] could not listen — is another PayProof running?');
  console.error(err);
  await closeDb();
  process.exit(1);
}

console.log('');
console.log('  payproof · reconciliation-first UPI collections');
console.log(`  dashboard   http://localhost:${config.port}/`);
console.log(`  health      http://localhost:${config.port}/health`);
console.log(`  database    ${config.dbDriver}${config.dbDriver === 'pglite' ? ` (${config.pgliteDir})` : ''}`);
console.log(`  demo key    ${config.apiKey}`);
console.log(`  window      ${config.paymentWindowMs / 1000}s · late grace ${config.lateGraceMs / 60_000}m`);
console.log('');

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
