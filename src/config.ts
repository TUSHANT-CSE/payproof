import { fileURLToPath } from 'node:url';

// Load .env if present (Node >= 20.12). Explicit shell values always win.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  // no .env file — defaults below are fine for the demo
}

const env = process.env;

const backoff = (env.WEBHOOK_BACKOFF_MS ?? '1000,5000,25000,125000,600000,1800000')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);

export const config = {
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? '127.0.0.1',
  apiKey: env.API_KEY ?? 'pk_demo_dev',
  paymentWindowMs: Number(env.PAYMENT_WINDOW_MS ?? 300_000),
  lateGraceMs: Number(env.LATE_GRACE_MS ?? 1_800_000),
  dbDriver: (env.DB_DRIVER ?? 'pglite') as 'pglite' | 'postgres',
  pgliteDir: env.PGLITE_DIR ?? './data/pgdata',
  databaseUrl: env.DATABASE_URL ?? null,
  webhookMaxAttempts: Number(env.WEBHOOK_MAX_ATTEMPTS ?? 6),
  webhookBackoff: backoff.length > 0 ? backoff : [1000],
  webhookTarget: env.WEBHOOK_TARGET ?? `http://localhost:${Number(env.PORT ?? 4000)}/webhook-sink`,
};
