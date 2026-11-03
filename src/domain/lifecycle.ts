import type { Db } from '../db.ts';
import { uid } from '../lib/util.ts';

export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  QUEUED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['AWAITING_VERIFICATION', 'OBSERVED', 'EXPIRED', 'CANCELLED'],
  AWAITING_VERIFICATION: ['OBSERVED', 'EXPIRED', 'CANCELLED'],
  OBSERVED: ['RECONCILED'],
  RECONCILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransition(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function recordTransition(
  d: Db,
  intentId: string,
  from: string | null,
  to: string,
  reason: string,
): Promise<void> {
  await d.query(
    `INSERT INTO intent_transitions (id, intent_id, from_status, to_status, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uid(), intentId, from, to, reason, Date.now()],
  );
}
