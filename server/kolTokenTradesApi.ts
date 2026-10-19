import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nodeAccountingService } from './nodeAccounting.js';
import { nodeReplayPreparation } from './nodeReplayPreparation.js';
import { nodeHistoricalImporter } from './nodeHistoricalImport.js';

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
export function registerKolTokenTradesRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string; token: string }; Querystring: { snapshot?: string } }>('/api/kols/:address/tokens/:token/replay-preparation', async (request, reply) => {
    const wallet = addressSchema.safeParse(request.params.address), token = addressSchema.safeParse(request.params.token);
    if (!wallet.success || !token.success) return reply.code(400).send({ error: 'Invalid KOL or token address' });
    if (request.query.snapshot !== undefined && !/^[a-f0-9]{64}$/.test(request.query.snapshot)) return reply.code(400).send({ error: 'Invalid replay snapshot' });
    const selection = { wallet: wallet.data, token: token.data, foreground: true };
    const activity = request.query.snapshot ? await nodeAccountingService.savedActivity(selection, request.query.snapshot) : await nodeAccountingService.activity(selection);
    if (!activity) return reply.code(404).send({ error: 'KOL token activity not found' });
    const prepared = await nodeReplayPreparation.prepare(activity);
    if (prepared.reason === 'chart_coverage' && prepared.window && activity.accountingSnapshot?.complete)
      await nodeHistoricalImporter.resumeChartGaps(wallet.data, token.data, prepared.window);
    if (prepared.status === 'ready' && activity.accountingSnapshot && !await nodeAccountingService.savedActivity(selection, activity.accountingSnapshot.snapshotId))
      return reply.code(410).send({ error: 'Replay evidence changed. Prepare the trade again.' });
    return reply.header('Cache-Control', 'no-store').send(prepared);
  });
  app.get<{ Params: { address: string; token: string }; Querystring: { replay?: string; pnl?: string; profile?: string } }>('/api/kols/:address/tokens/:token/activity', async (request, reply) => {
    const wallet = addressSchema.safeParse(request.params.address), token = addressSchema.safeParse(request.params.token);
    if (!wallet.success || !token.success) return reply.code(400).send({ error: 'Invalid KOL or token address' });
    const response = await nodeAccountingService.activity({ wallet: wallet.data, token: token.data,
      foreground: request.query.replay === 'true' || request.query.pnl === 'true' && request.query.profile !== 'true' });
    if (response === undefined) return reply.code(404).send({ error: 'KOL token activity not found' });
    if (!response) return reply.code(202).header('Cache-Control', 'no-store').header('Retry-After', '2').send({ status: 'pending' });
    if (response.realizedAccounting?.status === 'pending') reply.header('Retry-After', String(Math.ceil((response.realizedAccounting.retryAfterMs ?? 1500) / 1000)));
    return reply.header('Cache-Control', 'no-store').send(response);
  });
  app.get<{ Params: { address: string }; Querystring: { tokens?: string } }>('/api/kols/:address/token-summaries', async (request, reply) => {
    const wallet = addressSchema.safeParse(request.params.address), tokens = (request.query.tokens ?? '').split(',').filter(Boolean);
    if (!wallet.success || !tokens.length || tokens.length > 24 || tokens.some(token => !addressSchema.safeParse(token).success)) return reply.code(400).send({ error: 'Invalid summary request' });
    const summaries = await nodeAccountingService.summaries(wallet.data, tokens);
    return reply.header('Cache-Control', 'no-store').send({ summaries });
  });
}
