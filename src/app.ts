import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { ZodError } from 'zod';
import { ApiError } from './lib/errors.ts';
import { apiRoutes } from './routes/api.ts';
import { pageRoutes } from './routes/pages.ts';
import { sinkRoutes } from './routes/sink.ts';

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });

  await app.register(formbody);

  // Keep the raw JSON body for HMAC verification at /webhook-sink.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 2_000_000 },
    (req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      (req as typeof req & { rawBody?: string }).rawBody = text;
      if (text.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status).send({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof ZodError) {
      reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      reply.code(status).send({
        error: 'REQUEST_ERROR',
        message: err instanceof Error ? err.message : 'Request failed',
      });
      return;
    }
    console.error('[error]', err);
    reply.code(500).send({ error: 'INTERNAL', message: 'Unexpected server error' });
  });

  await app.register(apiRoutes);
  await app.register(pageRoutes);
  await app.register(sinkRoutes);
  return app;
}
