import type { FastifyRequest } from 'fastify';
import type { Merchant } from '../domain/types.ts';
import { getDb } from '../db.ts';
import { ApiError } from '../lib/errors.ts';
import { getMerchantByKey } from '../services/merchant.ts';

/** API auth: X-API-Key header, or `?key=` for shareable read-only demo links. */
export async function requireMerchant(req: FastifyRequest): Promise<Merchant> {
  const header = req.headers['x-api-key'];
  const query = (req.query as { key?: string } | undefined)?.key;
  const key = (Array.isArray(header) ? header[0] : header) ?? query ?? '';
  if (!key) throw new ApiError(401, 'UNAUTHORIZED', 'Missing X-API-Key header');
  const merchant = await getMerchantByKey(getDb(), key);
  if (!merchant) throw new ApiError(401, 'UNAUTHORIZED', 'Invalid API key');
  return merchant;
}

export function rawBody(req: FastifyRequest): string {
  return (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
}
