import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { config } from './config.ts';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export interface Store {
  db: Db;
  tx: <T>(fn: (d: Db) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

let store: Store | null = null;

export async function initDb(): Promise<Store> {
  if (store) return store;

  if (config.dbDriver === 'postgres') {
    const pool = new pg.Pool({ connectionString: config.databaseUrl ?? undefined });
    const db: Db = {
      async query(sql, params = []) {
        const r = await pool.query(sql, params as never[]);
        return r.rows as never;
      },
      async exec(sql) {
        await pool.query(sql);
      },
    };
    const tx = async <T>(fn: (d: Db) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const scoped: Db = {
          async query(sql, params = []) {
            const r = await client.query(sql, params as never[]);
            return r.rows as never;
          },
          async exec(sql) {
            await client.query(sql);
          },
        };
        const result = await fn(scoped);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* already gone */
        }
        throw err;
      } finally {
        client.release();
      }
    };
    store = { db, tx, close: async () => { await pool.end(); } };
  } else {
    const lite =
      config.pgliteDir === ':memory:'
        ? new PGlite()
        : (fs.mkdirSync(config.pgliteDir, { recursive: true }), new PGlite(config.pgliteDir));

    // PGlite is a single connection. If a plain query slipped in between BEGIN
    // and COMMIT it would become part of somebody else's transaction, so every
    // statement (and every transaction) goes through one promise-chain lock.
    let chain: Promise<unknown> = Promise.resolve();
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn, fn);
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const raw: Db = {
      async query(sql, params = []) {
        const r = await lite.query(sql, params as never[]);
        return r.rows as never;
      },
      async exec(sql) {
        await lite.exec(sql);
      },
    };
    const db: Db = {
      query: (sql, params = []) => exclusive(() => raw.query(sql, params)),
      exec: (sql) => exclusive(() => raw.exec(sql)),
    };
    const tx = async <T>(fn: (d: Db) => Promise<T>): Promise<T> =>
      exclusive(async () => {
        await raw.exec('BEGIN');
        try {
          const result = await fn(raw);
          await raw.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            await raw.exec('ROLLBACK');
          } catch {
            /* already rolled back */
          }
          throw err;
        }
      });
    store = { db, tx, close: async () => { await lite.close(); } };
  }

  await migrate(store.db);
  await seed(store.db);
  return store;
}

export function getStore(): Store {
  if (!store) throw new Error('Database not initialised — call initDb() first');
  return store;
}

export function getDb(): Db {
  return getStore().db;
}

export async function closeDb(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
  }
}

async function migrate(db: Db): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)',
  );
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const appliedRows = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRows.map((r) => r.version));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [file, Date.now()]);
  }
}

async function seed(db: Db): Promise<void> {
  const existing = await db.query('SELECT id FROM merchants LIMIT 1');
  if (existing.length > 0) return;
  const now = Date.now();
  const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  await db.query(
    `INSERT INTO merchants (id, name, vpa, api_key, webhook_url, webhook_secret, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['m_demo', 'Demo Merchant', 'demo@payproof', config.apiKey, config.webhookTarget, secret, now],
  );
  await db.query(
    `INSERT INTO accounts (id, merchant_id, vpa, label, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    ['acc_demo', 'm_demo', 'demo@payproof', 'Demo Receiving Account', now],
  );
}
