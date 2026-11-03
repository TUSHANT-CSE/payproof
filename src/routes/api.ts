import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getStore } from '../db.ts';
import { config } from '../config.ts';
import { ApiError } from '../lib/errors.ts';
import { parseRupeesToPaise } from '../lib/money.ts';
import { requireMerchant } from './auth.ts';
import { getAccount, getAccountForMerchant } from '../services/merchant.ts';
import {
  cancelIntent,
  claimIntent,
  createIntent,
  getIntent,
  intentDetail,
  listIntents,
} from '../services/intents.ts';
import { recordAlert, listReviews, resolveReview } from '../services/alerts.ts';
import { importStatement, reconciliationReport } from '../services/reconciliation.ts';

const amountFields = {
  amountPaise: z.number().int().positive().optional(),
  amount: z.union([z.number(), z.string()]).optional(),
};

function readAmount(body: { amountPaise?: number; amount?: number | string }): number {
  if (body.amountPaise !== undefined) {
    if (!Number.isSafeInteger(body.amountPaise) || body.amountPaise <= 0) {
      throw new ApiError(422, 'INVALID_AMOUNT', 'amountPaise must be a positive integer');
    }
    return body.amountPaise;
  }
  if (body.amount !== undefined) {
    const paise = parseRupeesToPaise(body.amount);
    if (paise === null) {
      throw new ApiError(422, 'INVALID_AMOUNT', 'amount must be a positive rupee value with up to 2 decimals');
    }
    return paise;
  }
  throw new ApiError(422, 'INVALID_AMOUNT', 'Provide amountPaise or amount');
}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  }
  return result.data;
}

function randomUtr(): string {
  let out = '4';
  for (let i = 0; i < 11; i++) out += randomInt(0, 10);
  return out;
}

const createSchema = z.object({
  orderId: z.string().trim().min(1).max(64),
  note: z.string().max(140).optional(),
  ...amountFields,
});

const alertSchema = z.object({
  accountId: z.string().min(1).optional(),
  utr: z.string().trim().regex(/^[A-Za-z0-9]{6,32}$/).optional(),
  source: z.enum(['sms', 'gmail', 'cdp', 'statement', 'simulator']).optional(),
  raw: z.string().max(2_000).optional(),
  receivedAt: z.number().int().positive().optional(),
  ...amountFields,
});

const importSchema = z.object({ csv: z.string().min(1).max(1_000_000) });

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    ok: true,
    service: 'payproof',
    driver: config.dbDriver,
    time: Date.now(),
  }));

  app.get('/api/intents', async (req) => {
    const merchant = await requireMerchant(req);
    const limit = Math.min(100, Math.max(1, Number((req.query as { limit?: string }).limit ?? 20)));
    return { intents: await listIntents(getStore().db, merchant.id, limit) };
  });

  app.post('/api/intents', async (req, reply) => {
    const merchant = await requireMerchant(req);
    const body = parse(createSchema, req.body);
    const result = await createIntent(getStore(), merchant, {
      orderId: body.orderId,
      amountPaise: readAmount(body),
      note: body.note ?? null,
    });
    reply.code(result.created ? 201 : 200);
    return result;
  });

  app.get('/api/intents/:id', async (req) => {
    const merchant = await requireMerchant(req);
    const id = (req.params as { id: string }).id;
    return intentDetail(getStore().db, id, merchant.id);
  });

  app.post('/api/intents/:id/claim', async (req) => {
    const merchant = await requireMerchant(req);
    const id = (req.params as { id: string }).id;
    return { intent: await claimIntent(getStore(), id, merchant.id) };
  });

  app.post('/api/intents/:id/cancel', async (req) => {
    const merchant = await requireMerchant(req);
    const id = (req.params as { id: string }).id;
    return { intent: await cancelIntent(getStore(), id, merchant.id) };
  });

  /** Public polling endpoint — deliberately narrow. */
  app.get('/api/public/intents/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const intent = await getIntent(getStore().db, id);
    return {
      id: intent.id,
      orderId: intent.order_id,
      amount: (intent.amount_paise / 100).toFixed(2),
      amountPaise: intent.amount_paise,
      status: intent.status,
      createdAt: intent.created_at,
      expiresAt: intent.expires_at,
      serverTime: Date.now(),
    };
  });

  /**
   * Evidence ingestion. This is what the SMS/Gmail/Android observers POST.
   * Matching is exact; anything else lands in the review queue.
   */
  app.post('/api/simulator/alert', async (req, reply) => {
    const merchant = await requireMerchant(req);
    const body = parse(alertSchema, req.body);
    let accountId: string;
    if (body.accountId) {
      const account = await getAccount(getStore().db, body.accountId);
      if (account.merchant_id !== merchant.id) {
        throw new ApiError(404, 'ACCOUNT_NOT_FOUND', `No account ${body.accountId}`);
      }
      accountId = account.id;
    } else {
      accountId = (await getAccountForMerchant(getStore().db, merchant.id)).id;
    }
    const utr = body.utr ?? randomUtr();
    const amountPaise = readAmount(body);
    const result = await recordAlert(getStore(), {
      accountId,
      amountPaise,
      utr,
      source: body.source ?? 'simulator',
      raw: body.raw,
      receivedAt: body.receivedAt,
    });
    reply.code(result.duplicate ? 200 : 201);
    return {
      duplicate: result.duplicate,
      matched: result.intent
        ? { id: result.intent.id, orderId: result.intent.order_id, status: result.intent.status }
        : null,
      review: result.review
        ? {
            id: result.review.id,
            reason: result.review.reason,
            suggestedIntentId: result.review.suggested_intent_id,
          }
        : null,
      alert: result.alert
        ? { id: result.alert.id, utr: result.alert.utr, amountPaise: result.alert.amount_paise }
        : null,
      settlementNote:
        'An observed alert is NOT settlement. Only statement reconciliation marks money as RECONCILED.',
    };
  });

  app.post('/api/reconciliation/import', async (req) => {
    const merchant = await requireMerchant(req);
    const body = parse(importSchema, req.body);
    const account = await getAccountForMerchant(getStore().db, merchant.id);
    return importStatement(getStore(), account.id, body.csv);
  });

  app.get('/api/reconciliation/report', async (req) => {
    const merchant = await requireMerchant(req);
    return reconciliationReport(getStore().db, merchant.id);
  });

  app.get('/api/review', async (req) => {
    const merchant = await requireMerchant(req);
    return { reviews: await listReviews(getStore().db, merchant.id, 50) };
  });

  app.post('/api/review/:id/resolve', async (req) => {
    const merchant = await requireMerchant(req);
    const id = (req.params as { id: string }).id;
    const body = parse(
      z.object({
        action: z.enum(['dismiss', 'link']),
        intentId: z.string().min(1).optional(),
      }),
      req.body,
    );
    return {
      review: await resolveReview(getStore(), id, body.action, body.intentId, merchant.id),
    };
  });
}
