import { getStore } from '../db.ts';
import { expireDue } from './intents.ts';

let timer: NodeJS.Timeout | null = null;

/** Expire payment windows once per second. Expiry promotes the next waiter. */
export function startSweeper(intervalMs = 1_000): () => void {
  if (timer) return () => {};
  const tick = async () => {
    try {
      await expireDue(getStore());
    } catch (err) {
      console.error('[sweeper]', err);
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
