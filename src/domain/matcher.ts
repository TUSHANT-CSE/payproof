/**
 * Pure matching logic — the heart of PayProof.
 *
 * An observed bank alert is matched to a payment intent ONLY when:
 *   - the amount is exactly equal (paise, no tolerance),
 *   - the intent is live (ACTIVE or AWAITING_VERIFICATION),
 *   - the alert could plausibly belong to the intent (created just before,
 *     and arriving no later than the payment window's expiry).
 *
 * Late alerts never auto-match. They become review suggestions instead.
 */

export const CLOCK_SKEW_MS = 60_000;

export interface AlertInput {
  amountPaise: number;
  receivedAt: number;
  utr: string;
}

export interface IntentCandidate {
  id: string;
  amountPaise: number;
  status: string;
  createdAt: number;
  expiresAt: number | null;
}

function isLive(status: string): boolean {
  return status === 'ACTIVE' || status === 'AWAITING_VERIFICATION';
}

export function isEligible(candidate: IntentCandidate, alert: AlertInput): boolean {
  if (!isLive(candidate.status)) return false;
  if (candidate.amountPaise !== alert.amountPaise) return false;
  if (alert.receivedAt < candidate.createdAt - CLOCK_SKEW_MS) return false;
  if (candidate.expiresAt !== null && alert.receivedAt > candidate.expiresAt) return false;
  return true;
}

export function findMatch(
  alert: AlertInput,
  candidates: IntentCandidate[],
): IntentCandidate | null {
  const eligible = candidates.filter((c) => isEligible(c, alert));
  eligible.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return eligible[0] ?? null;
}

/**
 * For alerts that arrived after the payment window closed: surface the most
 * recently expired intent with the same amount as a *suggestion* for a human,
 * never as an automatic match.
 */
export function findLateSuggestion(
  alert: AlertInput,
  expiredCandidates: IntentCandidate[],
  graceMs: number,
): IntentCandidate | null {
  const candidates = expiredCandidates.filter((c) => {
    if (c.status !== 'EXPIRED') return false;
    if (c.amountPaise !== alert.amountPaise) return false;
    if (c.expiresAt === null) return false;
    const lateness = alert.receivedAt - c.expiresAt;
    return lateness > 0 && lateness <= graceMs;
  });
  candidates.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  return candidates[0] ?? null;
}
