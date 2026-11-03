import { randomUUID } from 'node:crypto';

export function uid(): string {
  return randomUUID();
}

export function num(value: unknown): number {
  return Number(value);
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === '23505' || /duplicate key/i.test(e?.message ?? '');
}

/** Serialize async critical sections inside this process (single-writer demo). */
let chain: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function fmtINR(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-IN', { hour12: false });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
