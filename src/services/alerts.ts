import type { Db, Store } from '../db.ts';
import type { AlertRow, Intent, ReviewRow } from '../domain/types.ts';
import { toAlert, toIntent, toReview } from '../domain/map.ts';
import { findLateSuggestion, findMatch } from '../domain/matcher.ts';
import { recordTransition } from '../domain/lifecycle.ts';
import { ApiError } from '../lib/errors.ts';
import { uid } from '../lib/util.ts';
import { serialize } from '../lib/util.ts';
import { config } from '../config.ts';
import { enqueueWebhook } from './webhooks.ts';
import { promoteNext } from './intents.ts';
import { getAccount, getMerchant } from './merchant.ts';

export interface RecordAlertInput {
  accountId: string;
  amountPaise: number;
  utr: string;
  source?: string;
  raw?: string;
  receivedAt?: number;
}

export interface RecordAlertResult {
  duplicate: boolean;
  alert: AlertRow | null;
  intent: Intent | null;
  review: ReviewRow | null;
}

function defaultRaw(input: RecordAlertInput, rupees: string): string {
  return `Bank alert: INR ${rupees} credited to your account. UTR ${input.utr}.`;
}

/**
 * Record an observed bank credit and try to attribute it.
 *
 * Attribution is exact: same paise amount, intent live at the time, alert not
 * older than the intent (accounting for clock skew) and not later than expiry.
 * Anything else lands in the review queue and never touches a payment status.
 */
export async function recordAlert(store: Store, input: RecordAlertInput): Promise<RecordAlertResult> {
  return serialize(() =>
    store.tx(async (d) => {
      const account = await getAccount(d, input.accountId);
      const now = Date.now();
      const receivedAt = input.receivedAt ?? now;
      const raw = input.raw?.trim() || defaultRaw(input, (input.amountPaise / 100).toFixed(2));
      const id = 'al_' + uid();

      // ON CONFLICT keeps the transaction usable when a bank (or CDP scraper)
      // replays the same alert. The UTR is the idempotency key.
      const inserted = await d.query(
        `INSERT INTO alerts (id, account_id, source, raw, amount_paise, utr, received_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (account_id, utr) DO NOTHING
         RETURNING *`,
        [id, account.id, input.source ?? 'simulator', raw, input.amountPaise, input.utr, receivedAt, now],
      );
      if (!inserted[0]) {
        return { duplicate: true, alert: null, intent: null, review: null };
      }
      const alert = toAlert(inserted[0]);

      const liveRows = await d.query(
        `SELECT * FROM payment_intents
          WHERE account_id = $1 AND status IN ('ACTIVE','AWAITING_VERIFICATION')`,
        [account.id],
      );
      const live = liveRows.map(toIntent);
      const match = findMatch(
        { amountPaise: alert.amount_paise, receivedAt: alert.received_at, utr: alert.utr },
        live.map((i) => ({
          id: i.id,
          amountPaise: i.amount_paise,
          status: i.status,
          createdAt: i.created_at,
          expiresAt: i.expires_at,
        })),
      );

      if (match) {
        const claimed = await d.query(
          `UPDATE payment_intents SET status='OBSERVED', observed_at=$2
            WHERE id=$1 AND status IN ('ACTIVE','AWAITING_VERIFICATION') RETURNING *`,
          [match.id, now],
        );
        if (claimed[0]) {
          const intent = toIntent(claimed[0]);
          const from = live.find((i) => i.id === match.id)?.status ?? 'ACTIVE';
          await d.query('UPDATE alerts SET intent_id = $2 WHERE id = $1', [alert.id, intent.id]);
          await recordTransition(d, intent.id, from, 'OBSERVED', `bank_alert:${alert.source}`);
          const merchant = await getMerchant(d, intent.merchant_id);
          await enqueueWebhook(d, merchant, intent, 'payment.observed', alert.utr, 'NOT_RECONCILED');
          await promoteNext(d, account.id);
          alert.intent_id = intent.id;
          return { duplicate: false, alert, intent, review: null };
        }
      }

      // No live match. Surface a possible late settlement but never auto-apply it.
      const expiredRows = await d.query(
        `SELECT * FROM payment_intents
          WHERE account_id = $1 AND status = 'EXPIRED' AND amount_paise = $2`,
        [account.id, alert.amount_paise],
      );
      const suggestion = findLateSuggestion(
        { amountPaise: alert.amount_paise, receivedAt: alert.received_at, utr: alert.utr },
        expiredRows.map(toIntent).map((i) => ({
          id: i.id,
          amountPaise: i.amount_paise,
          status: i.status,
          createdAt: i.created_at,
          expiresAt: i.expires_at,
        })),
        config.lateGraceMs,
      );
      const reason = suggestion ? 'POSSIBLE_LATE_MATCH' : 'NO_ELIGIBLE_INTENT';
      const review: ReviewRow = {
        id: 'rv_' + uid(),
        alert_id: alert.id,
        reason,
        suggested_intent_id: suggestion?.id ?? null,
        status: 'OPEN',
        created_at: now,
      };
      await d.query(
        `INSERT INTO alert_reviews (id, alert_id, reason, suggested_intent_id, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [review.id, review.alert_id, review.reason, review.suggested_intent_id, review.status, review.created_at],
      );
      return { duplicate: false, alert, intent: null, review };
    }),
  );
}

export async function listReviews(d: Db, merchantId: string, limit = 20): Promise<ReviewRow[]> {
  const rows = await d.query(
    `SELECT r.*, a.utr, a.amount_paise, a.source, a.received_at
       FROM alert_reviews r
       JOIN alerts a ON a.id = r.alert_id
       JOIN accounts ac ON ac.id = a.account_id
      WHERE r.status = 'OPEN' AND ac.merchant_id = $1
      ORDER BY r.created_at DESC LIMIT $2`,
    [merchantId, limit],
  );
  return rows.map(toReview);
}

/**
 * Human resolution of a review-queue alert.
 *  - dismiss: close without touching any payment.
 *  - link: operator explicitly attaches the late alert to an EXPIRED intent.
 *    This is the one deliberate override of the state machine and it is
 *    always recorded as `manual_review_late_match`.
 */
export async function resolveReview(
  store: Store,
  reviewId: string,
  action: 'dismiss' | 'link',
  intentId?: string,
  merchantId?: string,
): Promise<ReviewRow> {
  return serialize(() =>
    store.tx(async (d) => {
      const rows = await d.query(
        `SELECT r.*, a.amount_paise AS alert_amount, a.utr AS alert_utr,
                a.account_id AS alert_account, ac.merchant_id AS account_merchant
           FROM alert_reviews r
           JOIN alerts a ON a.id = r.alert_id
           JOIN accounts ac ON ac.id = a.account_id
          WHERE r.id = $1`,
        [reviewId],
      );
      if (!rows[0]) throw new ApiError(404, 'REVIEW_NOT_FOUND', `No review ${reviewId}`);
      const row = rows[0];
      if (merchantId && String(row.account_merchant) !== merchantId) {
        throw new ApiError(404, 'REVIEW_NOT_FOUND', `No review ${reviewId}`);
      }
      if (String(row.status) !== 'OPEN') {
        throw new ApiError(409, 'REVIEW_CLOSED', 'This review is already resolved');
      }

      if (action === 'dismiss') {
        const updated = await d.query(
          `UPDATE alert_reviews SET status='DISMISSED' WHERE id=$1 RETURNING *`,
          [reviewId],
        );
        return toReview(updated[0]);
      }

      const targetId = intentId ?? (row.suggested_intent_id as string | null);
      if (!targetId) {
        throw new ApiError(422, 'NO_TARGET_INTENT', 'Provide an intentId to link this alert to');
      }
      const targetRows = await d.query(
        'SELECT * FROM payment_intents WHERE id = $1',
        [targetId],
      );
      if (!targetRows[0]) throw new ApiError(404, 'INTENT_NOT_FOUND', `No payment intent ${targetId}`);
      const target = toIntent(targetRows[0]);
      if (target.amount_paise !== Number(row.alert_amount)) {
        throw new ApiError(422, 'AMOUNT_MISMATCH', 'Alert amount does not match the intent');
      }
      if (target.status !== 'EXPIRED' && target.status !== 'OBSERVED') {
        throw new ApiError(409, 'INVALID_STATE', `Intent is ${target.status}, not reviewable`);
      }

      if (target.status === 'EXPIRED') {
        const updated = await d.query(
          `UPDATE payment_intents SET status='OBSERVED', observed_at=$2
            WHERE id=$1 AND status='EXPIRED' RETURNING *`,
          [target.id, Date.now()],
        );
        if (!updated[0]) throw new ApiError(409, 'INVALID_STATE', 'Intent changed during review');
        await d.query('UPDATE alerts SET intent_id=$2 WHERE id=$1', [row.alert_id, target.id]);
        await recordTransition(
          d,
          target.id,
          'EXPIRED',
          'OBSERVED',
          'manual_review_late_match',
        );
        const merchant = await getMerchant(d, target.merchant_id);
        await enqueueWebhook(
          d,
          merchant,
          toIntent(updated[0]),
          'payment.observed',
          String(row.alert_utr),
          'NOT_RECONCILED',
        );
      }

      const resolved = await d.query(
        `UPDATE alert_reviews SET status='RESOLVED' WHERE id=$1 RETURNING *`,
        [reviewId],
      );
      return toReview(resolved[0]);
    }),
  );
}
