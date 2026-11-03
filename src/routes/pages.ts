import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { getStore } from '../db.ts';
import { ApiError } from '../lib/errors.ts';
import { parseRupeesToPaise } from '../lib/money.ts';
import { clearSinkLog, sinkLog } from '../services/sink.ts';
import { getAccountForMerchant, getDemoMerchant } from '../services/merchant.ts';
import {
  cancelIntent,
  claimIntent,
  createIntent,
  dashboardStats,
  intentDetail,
  listIntents,
  upiUri,
} from '../services/intents.ts';
import { listReviews, recordAlert, resolveReview } from '../services/alerts.ts';
import { importStatement, reconciliationReport } from '../services/reconciliation.ts';
import { listDeliveries } from '../services/webhooks.ts';
import { checkoutPage, dashboardPage, intentPage } from '../ui.ts';

type Form = Record<string, string | undefined>;

function form(req: FastifyRequest): Form {
  return (req.body ?? {}) as Form;
}

function redirect(reply: FastifyReply, url: string): void {
  reply.code(303).header('location', url).send();
}

function flash(reply: FastifyReply, path: string, message: string, kind: 'ok' | 'err' = 'ok'): void {
  redirect(reply, `${path}?msg=${encodeURIComponent(message)}&kind=${kind}`);
}

async function demo() {
  const merchant = await getDemoMerchant(getStore().db);
  const account = await getAccountForMerchant(getStore().db, merchant.id);
  return { merchant, account };
}

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const { merchant, account } = await demo();
    const d = getStore().db;
    const query = req.query as { msg?: string; kind?: string };
    const intents = await listIntents(d, merchant.id, 20);
    const [stats, reviews, deliveries, report] = await Promise.all([
      dashboardStats(d, merchant.id),
      listReviews(d, merchant.id, 10),
      listDeliveries(d, 10),
      reconciliationReport(d, merchant.id),
    ]);
    const liveSlot =
      intents.find((i) => i.status === 'ACTIVE' || i.status === 'AWAITING_VERIFICATION') ?? null;
    reply.type('text/html').send(
      dashboardPage({
        merchant,
        account,
        stats,
        intents,
        reviews,
        deliveries,
        report,
        log: sinkLog(),
        liveSlot,
        msg: query.msg,
        kind: query.kind,
      }),
    );
  });

  app.post('/ui/intents', async (req, reply) => {
    const { merchant } = await demo();
    const body = form(req);
    const amountPaise = parseRupeesToPaise(body.amount ?? '');
    if (!body.orderId || amountPaise === null) {
      flash(reply, '/', 'Enter an order ID and a positive rupee amount.', 'err');
      return;
    }
    try {
      const result = await createIntent(getStore(), merchant, {
        orderId: body.orderId.trim(),
        amountPaise,
        note: body.note?.trim() || null,
      });
      redirect(reply, result.checkoutUrl);
    } catch (err) {
      flash(reply, '/', err instanceof ApiError ? err.message : 'Could not create the intent.', 'err');
    }
  });

  app.post('/ui/simulate', async (req, reply) => {
    const { account } = await demo();
    const body = form(req);
    const amountPaise = parseRupeesToPaise(body.amount ?? '');
    if (amountPaise === null) {
      flash(reply, '/', 'Enter a positive amount for the bank alert.', 'err');
      return;
    }
    const utr = body.utr?.trim() || undefined;
    try {
      const result = await recordAlert(getStore(), {
        accountId: account.id,
        amountPaise,
        utr: utr && /^[A-Za-z0-9]{6,32}$/.test(utr) ? utr : randomUtr(),
        source: body.source || 'sms',
      });
      if (result.duplicate) {
        flash(reply, '/', 'Duplicate UTR — the bank alert was ignored (idempotent ingestion).', 'err');
      } else if (result.intent) {
        flash(
          reply,
          `/intents/${result.intent.id}`,
          `Alert matched ${result.intent.order_id} → OBSERVED. Not settled until the statement is imported.`,
        );
      } else {
        flash(
          reply,
          '/',
          `No live intent matched. Alert sent to the review queue (${result.review?.reason ?? 'NO_ELIGIBLE_INTENT'}).`,
          'err',
        );
      }
    } catch (err) {
      flash(reply, '/', err instanceof ApiError ? err.message : 'Could not record the alert.', 'err');
    }
  });

  app.post('/ui/import', async (req, reply) => {
    const { account } = await demo();
    const body = form(req);
    try {
      const summary = await importStatement(getStore(), account.id, body.csv ?? '');
      flash(
        reply,
        '/',
        `Statement: ${summary.imported} imported (${summary.duplicates} duplicate), ` +
          `${summary.reconciled} reconciled, ${summary.unmatched} unmatched.`,
        summary.reconciled > 0 ? 'ok' : 'err',
      );
    } catch (err) {
      flash(reply, '/', err instanceof ApiError ? err.message : 'Import failed.', 'err');
    }
  });

  app.post('/ui/review/:id', async (req, reply) => {
    const { merchant } = await demo();
    const body = form(req);
    const id = (req.params as { id: string }).id;
    const action = body.action === 'link' ? 'link' : 'dismiss';
    try {
      await resolveReview(getStore(), id, action, body.intentId, merchant.id);
      flash(
        reply,
        '/',
        action === 'link'
          ? 'Alert linked to the expired intent → OBSERVED (manual). Still needs the statement.'
          : 'Review dismissed. No payment state changed.',
      );
    } catch (err) {
      flash(reply, '/', err instanceof ApiError ? err.message : 'Could not resolve the review.', 'err');
    }
  });

  app.post('/ui/claim/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      await claimIntent(getStore(), id);
      redirect(reply, `/checkout/${id}`);
    } catch (err) {
      flash(reply, `/checkout/${id}`, err instanceof ApiError ? err.message : 'Could not claim.', 'err');
    }
  });

  app.post('/ui/cancel/:id', async (req, reply) => {
    const { merchant } = await demo();
    const id = (req.params as { id: string }).id;
    try {
      await cancelIntent(getStore(), id, merchant.id);
      flash(reply, `/intents/${id}`, 'Intent cancelled and the slot freed.');
    } catch (err) {
      flash(reply, `/intents/${id}`, err instanceof ApiError ? err.message : 'Could not cancel.', 'err');
    }
  });

  app.get('/checkout/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const detail = await intentDetail(getStore().db, id);
    const qrSvg = await QRCode.toString(upiUri(detail.merchant, detail.intent), {
      type: 'svg',
      margin: 1,
      width: 260,
      errorCorrectionLevel: 'M',
    });
    reply.type('text/html').send(
      checkoutPage({ detail, qrSvg, serverNow: Date.now() }),
    );
  });

  app.get('/intents/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const detail = await intentDetail(getStore().db, id);
    reply.type('text/html').send(intentPage(detail));
  });

  app.get('/debug/clear-log', async (_req, reply) => {
    clearSinkLog();
    redirect(reply, '/');
  });
}

/** Short, human-readable UTR for the simulator. Not a real bank reference. */
function randomUtr(): string {
  let out = '4';
  for (let i = 0; i < 11; i++) out += randomInt(0, 10);
  return out;
}
