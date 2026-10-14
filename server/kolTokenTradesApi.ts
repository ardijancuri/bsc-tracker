import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import { pool } from './db.js';
import { nonStockTokenSql } from './stockToken.js';
import { summarizeKolTokenTrades, type IndexedKolTokenTrade } from './kolTokenTrades.js';
import { currentKolTokenInventory } from './kolTokenInventory.js';
import { currentTradeReplayGmgnAccounting } from './tradeReplayGmgn.js';
import { currentKolTokenGmgnPnl } from './kolTokenGmgnPnl.js';

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
export const kolTokenHistoryLimit = 2000;
const pairWhere = `t.wallet_address=$1 AND t.token_address=$2 AND k.is_tracked AND t.block_number IS NOT NULL
  AND t.timestamp<=now() AND ${nonStockTokenSql('t.token_address')}`;

export function registerKolTokenTradesRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string; token: string }; Querystring: { replay?: string; pnl?: string } }>('/api/kols/:address/tokens/:token/activity', async (request, reply) => {
    const wallet = addressSchema.safeParse(request.params.address), token = addressSchema.safeParse(request.params.token);
    if (!wallet.success || !token.success) return reply.code(400).send({ error: 'Invalid KOL or token address' });
    const values = [wallet.data, token.data];
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
        FROM kols k JOIN tokens v ON v.address=$2
        CROSS JOIN LATERAL(SELECT COUNT(*)::int AS count,MIN(t.timestamp) AS first_trade,MAX(t.timestamp) AS last_trade,
          COUNT(*) FILTER(WHERE t.side='buy')::int AS buys,COUNT(*) FILTER(WHERE t.side='sell')::int AS sells,MIN(t.block_number) AS first_block
          FROM trades t WHERE t.wallet_address=k.address AND t.token_address=v.address AND t.block_number IS NOT NULL AND t.timestamp<=now()) history
        WHERE k.address=$1 AND k.is_tracked AND ${nonStockTokenSql()} AND history.count>0`, values),
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
        FROM trades t JOIN kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address
        WHERE ${pairWhere} ORDER BY t.timestamp DESC,t.block_number DESC,t.transaction_index DESC NULLS LAST,t.id DESC LIMIT $3`, [...values, kolTokenHistoryLimit]),
    ]);
    const row = identity.rows[0];
    if (!row) return reply.code(404).send({ error: 'KOL token activity not found' });
    const indexedTradeCount = Number(row.indexedTradeCount);
    const complete = indexedTradeCount === activity.rows.length && indexedTradeCount <= kolTokenHistoryLimit;
    const inventory = await currentKolTokenInventory({ wallet: wallet.data, token: token.data, firstBlock: row.firstBlock ?? null,
      decimals: row.token.decimals ?? null, trades: activity.rows, tradesComplete: complete });
    const result = summarizeKolTokenTrades(activity.rows as IndexedKolTokenTrade[], wallet.data, token.data, row.token.marketCapSupply, complete, Date.now(), inventory);
    // Full-history metadata remains accurate when the latest history exceeds the bounded payload.
    result.summary.buyCount = Number(row.buyCount); result.summary.sellCount = Number(row.sellCount);
    result.summary.firstTradeAt = new Date(row.firstTradeAt).toISOString(); result.summary.lastTradeAt = new Date(row.lastTradeAt).toISOString();
    const response: KolTokenActivity = {
      kol: row.kol, token: row.token, ...result,
      coverage: { source: 'indexed', indexedTradeCount, returnedTradeCount: result.trades.length, complete,
        historyLimit: kolTokenHistoryLimit, costsIncluded: false }, generatedAt: new Date().toISOString(),
    };
    if (request.query.replay === 'true') {
      response.replayAccounting = await currentTradeReplayGmgnAccounting(response);
      const realized = await currentKolTokenGmgnPnl(response, response.replayAccounting, { markPosition: request.query.pnl === 'true' });
      if (request.query.pnl === 'true') response.realizedAccounting = realized;
    } else if (request.query.pnl === 'true') response.realizedAccounting = await currentKolTokenGmgnPnl(response);
    if (response.inventory?.coverage.status === 'pending') reply.header('Retry-After', '1');
    if (response.realizedAccounting?.status === 'pending') reply.header('Retry-After', String(Math.ceil((response.realizedAccounting.retryAfterMs ?? 1000) / 1000)));
    else if (response.realizedAccounting?.position?.status === 'open' && response.realizedAccounting.position.estimatedProfitUsd === null) {
      reply.header('Retry-After', String(Math.ceil((response.realizedAccounting.position.retryAfterMs ?? 3000) / 1000)));
    }
    return reply.header('Cache-Control', 'no-store').send(response);
  });
}
