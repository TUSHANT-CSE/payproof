import type { FastifyInstance } from 'fastify';
import { getStore } from '../db.ts';
import { recordSink } from '../services/sink.ts';
import { verifySignature } from '../services/webhooks.ts';
import { rawBody } from './auth.ts';

/**
 * Demo webhook receiver. Verifies the HMAC and records what arrived so the
 * dashboard can show signature validity. A real merchant endpoint would do
 * this plus dedupe by delivery id.
 */
export async function sinkRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhook-sink', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = rawBody(req);
    const deliveryId = String(body.deliveryId ?? '');
    const event = String(body.event ?? '');
    const orderId = String(body.orderId ?? '');
    const amount = String(body.amount ?? '');
    const headerTimestamp = Number(req.headers['x-payproof-timestamp'] ?? NaN);
    const bodyTimestamp = Number(body.timestamp ?? NaN);
    const signature = String(req.headers['x-payproof-signature'] ?? '');

    if (!deliveryId || !Number.isFinite(headerTimestamp) || headerTimestamp !== bodyTimestamp) {
      reply.code(400).send({ ok: false, error: 'malformed delivery' });
      return;
    }

    const rows = await getStore().db.query(
      `SELECT m.webhook_secret
         FROM webhook_deliveries wd
         JOIN payment_intents i ON i.id = wd.intent_id
         JOIN merchants m ON m.id = i.merchant_id
        WHERE wd.id = $1`,
      [deliveryId],
    );
    const secret = rows[0]?.webhook_secret ? String(rows[0].webhook_secret) : '';
    const valid = secret ? verifySignature(secret, headerTimestamp, raw, signature) : false;

    recordSink({
      at: Date.now(),
      event,
      deliveryId,
      orderId,
      amount,
      signatureOk: valid,
      body: raw,
    });

    if (!valid) {
      reply.code(401).send({ ok: false, error: 'invalid signature' });
      return;
    }
    reply.code(200).send({ ok: true, deliveryId });
  });
}
