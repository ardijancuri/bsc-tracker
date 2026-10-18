import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import { pool } from './db.js';
import { isExcludedKolProfileTokenAddress, kolProfileTokenSql } from './kolProfileToken.js';
import { summarizeKolTokenTrades, type IndexedKolTokenTrade } from './kolTokenTrades.js';
import { currentKolTokenInventory } from './kolTokenInventory.js';
import { currentTradeReplayGmgnAccounting } from './tradeReplayGmgn.js';
import { currentKolTokenGmgnPnl } from './kolTokenGmgnPnl.js';
import { createKolTokenProfilePnl } from './kolTokenProfilePnl.js';

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
export const kolTokenHistoryLimit = 2000;
const pairWhere = `t.wallet_address=$1 AND t.token_address=$2 AND k.is_tracked AND t.block_number IS NOT NULL
  AND t.timestamp<=now() AND ${kolProfileTokenSql()}`;

const profilePnl = createKolTokenProfilePnl();
/** Internal adapter: private callers must authorize membership before AND after this asynchronous work. */
export async function loadKolTokenActivity(options: { wallet: string; token: string; replay?: boolean; pnl?: boolean; background?: boolean; allowPrivate?: boolean; skipInventory?: boolean; profileCache?: ReturnType<typeof createKolTokenProfilePnl> }): Promise<KolTokenActivity | null | undefined> {
    const { wallet, token } = options;
    if (!addressSchema.safeParse(wallet).success || !addressSchema.safeParse(token).success || isExcludedKolProfileTokenAddress(token)) return undefined;
    const values = [wallet, token];
    const [identity, activity] = await Promise.all([
      pool.query(`SELECT
        json_build_object('address',k.address,'name',k.display_name,'avatarUrl',k.avatar_url,'twitter',k.twitter,
          'source',k.source,'lastSeenAt',k.last_seen_at) AS kol,
        json_build_object('address',v.address,'symbol',v.symbol,'name',v.name,
          'logoUrl',CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END,
          'priceUsd',CASE WHEN v.price_source='onchain' THEN v.price_usd::text END,
          'marketCapUsd',(CASE WHEN v.market_cap_usd>0 AND v.market_cap_checked_at>now()-interval '2 hours' THEN v.market_cap_usd
            WHEN v.price_source='onchain' AND v.price_usd>0 AND v.total_supply_raw>0 AND v.decimals BETWEEN 0 AND 36
              AND v.supply_checked_at>now()-interval '2 days' THEN v.price_usd*v.total_supply_raw/power(10::numeric,v.decimals) END)::text,
          'decimals',v.decimals,'marketCapSupply',CASE WHEN v.total_supply_raw>0 AND v.decimals BETWEEN 0 AND 36 AND v.supply_checked_at>now()-interval '2 days'
            THEN (v.total_supply_raw/power(10::numeric,v.decimals))::text END) AS token,
        history.count AS "indexedTradeCount",history.first_trade AS "firstTradeAt",history.last_trade AS "lastTradeAt",
        history.buys AS "buyCount",history.sells AS "sellCount",history.first_block::text AS "firstBlock"
        FROM published_kols k JOIN tokens v ON v.address=$2
        CROSS JOIN LATERAL(SELECT COUNT(*)::int AS count,MIN(t.timestamp) AS first_trade,MAX(t.timestamp) AS last_trade,
          COUNT(*) FILTER(WHERE t.side='buy')::int AS buys,COUNT(*) FILTER(WHERE t.side='sell')::int AS sells,MIN(t.block_number) AS first_block
          FROM trades t WHERE t.wallet_address=k.address AND t.token_address=v.address AND t.block_number IS NOT NULL AND t.timestamp<=now()) history
        WHERE k.address=$1 AND (${options.allowPrivate ? 'true' : 'k.is_tracked'}) AND ${kolProfileTokenSql()} AND ${options.allowPrivate ? 'true' : 'history.count>0'}`, values),
      pool.query(`SELECT t.id,t.tx_hash AS "txHash",t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",
        k.display_name AS "kolName",k.avatar_url AS "kolAvatarUrl",k.twitter AS "kolTwitter",v.symbol AS "tokenSymbol",v.name AS "tokenName",
        CASE WHEN v.logo_data IS NOT NULL THEN '/api/token-image/'||v.address||'?v='||md5(v.logo_data) END AS "tokenLogoUrl",
        t.side,t.token_amount::text AS "tokenAmount",t.quote_symbol AS "quoteSymbol",t.quote_token_address AS "quoteTokenAddress",t.quote_amount::text AS "quoteAmount",
        t.amount_usd::text AS "amountUsd",t.price_usd::text AS "priceUsd",t.timestamp,t.source,
        t.block_number::text AS "blockNumber",t.block_hash AS "blockHash",t.transaction_index AS "transactionIndex",
        EXISTS(SELECT 1 FROM trades other JOIN tokens asset ON asset.address=other.token_address
          WHERE other.wallet_address=t.wallet_address AND other.tx_hash=t.tx_hash AND other.side=t.side
            AND other.token_address<>t.token_address AND other.block_number IS NOT NULL
            AND other.quote_symbol=t.quote_symbol AND other.quote_amount=t.quote_amount AND other.amount_usd=t.amount_usd
            AND COALESCE(asset.symbol,'') !~* 'dividend[_ ]?tracker') AS "sharedQuote"
        FROM trades t JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address
        WHERE ${pairWhere.replace('k.is_tracked', options.allowPrivate ? 'true' : 'k.is_tracked')} ORDER BY t.timestamp DESC,t.block_number DESC,t.transaction_index DESC NULLS LAST,t.id DESC LIMIT $3`, [...values, kolTokenHistoryLimit]),
    ]);
    const row = identity.rows[0];
    if (!row) return undefined;
    if (!row.kol.name) row.kol.name = `${wallet.slice(0,6)}…${wallet.slice(-4)}`;
    const indexedTradeCount = Number(row.indexedTradeCount);
    const complete = indexedTradeCount === activity.rows.length && indexedTradeCount <= kolTokenHistoryLimit;
    const background = options.background === true && options.pnl === true && !options.replay;
    const prepare = async () => {
      const inventory = options.allowPrivate && options.skipInventory ? undefined : await currentKolTokenInventory({ wallet: wallet, token: token, firstBlock: row.firstBlock ?? null,
        decimals: row.token.decimals ?? null, trades: activity.rows, tradesComplete: complete, ...(background ? { priority: 'background' as const } : {}) });
      const result = summarizeKolTokenTrades(activity.rows as IndexedKolTokenTrade[], wallet, token, row.token.marketCapSupply, complete, Date.now(), inventory);
      // Full-history metadata remains accurate when the latest history exceeds the bounded payload.
      result.summary.buyCount = Number(row.buyCount); result.summary.sellCount = Number(row.sellCount);
      result.summary.firstTradeAt = row.firstTradeAt ? new Date(row.firstTradeAt).toISOString() : null; result.summary.lastTradeAt = row.lastTradeAt ? new Date(row.lastTradeAt).toISOString() : null;
      const response: KolTokenActivity = {
        kol: row.kol, token: row.token, ...result,
        coverage: { source: 'indexed', indexedTradeCount, returnedTradeCount: result.trades.length, complete,
          historyLimit: kolTokenHistoryLimit, costsIncluded: false }, generatedAt: new Date().toISOString(),
      };
      if (options.replay === true) {
        response.replayAccounting = await currentTradeReplayGmgnAccounting(response);
        const realized = await currentKolTokenGmgnPnl(response, response.replayAccounting, { markPosition: options.pnl === true, foreground: true });
        if (options.pnl === true) response.realizedAccounting = realized;
      } else if (options.pnl === true) response.realizedAccounting = await currentKolTokenGmgnPnl(response, undefined, { foreground: !background });
      return response;
    };
    // Every poll rereads indexed evidence. New swaps, corrected quantities/costs,
    // or supply changes invalidate the short snapshot even with the same last trade time.
    const revision = background ? createHash('sha256').update(JSON.stringify([row.firstBlock, indexedTradeCount, row.buyCount, row.sellCount, row.firstTradeAt, row.lastTradeAt, row.token.decimals, row.token.marketCapSupply, activity.rows])).digest('hex') : '';
    const response = background ? await (options.profileCache ?? profilePnl)(`${wallet}:${token}`, revision, prepare) : await prepare();
    return response;
}

export function registerKolTokenTradesRoutes(app: FastifyInstance) {
  const profileCache = createKolTokenProfilePnl();
  app.get<{ Params: { address: string; token: string }; Querystring: { replay?: string; pnl?: string; profile?: string } }>('/api/kols/:address/tokens/:token/activity', async (request, reply) => {
    const wallet = addressSchema.safeParse(request.params.address), token = addressSchema.safeParse(request.params.token);
    if (!wallet.success || !token.success) return reply.code(400).send({ error: 'Invalid KOL or token address' });
    const response = await loadKolTokenActivity({ wallet: wallet.data, token: token.data,
      replay: request.query.replay === 'true', pnl: request.query.pnl === 'true', background: request.query.profile === 'true', profileCache });
    if (response === undefined) return reply.code(404).send({ error: 'KOL token activity not found' });
    if (!response) return reply.code(202).header('Cache-Control', 'no-store').header('Retry-After', '1').send({ status: 'pending' });
    if (response.inventory?.coverage.status === 'pending') reply.header('Retry-After', '1');
    if (response.realizedAccounting?.status === 'pending') reply.header('Retry-After', String(Math.ceil((response.realizedAccounting.retryAfterMs ?? 1000) / 1000)));
    else if (response.realizedAccounting?.position?.status === 'open' && response.realizedAccounting.position.estimatedProfitUsd === null) {
      reply.header('Retry-After', String(Math.ceil((response.realizedAccounting.position.retryAfterMs ?? 3000) / 1000)));
    }
    return reply.header('Cache-Control', 'no-store').send(response);
  });
}
