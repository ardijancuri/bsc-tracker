import type { FastifyInstance } from 'fastify';
import type { QueryResultRow } from 'pg';
import { defaultTrendingWindow, isTrendingWindow, trendingWindows, type MarketMomentumToken, type TrendingKol, type TrendingTokens, type TrendingWindow } from '../../shared/trendingTokens.js';
import { kolProfileTokenSql } from '../kolProfileToken.js';
import { freshPublicTradeScopeSql } from './publicTokens.js';
import { freshTokenDirectoryIdentity } from './tokenDirectory.js';
import { freshTrackedEventSql } from './tracking.js';

type TrendingDb = {
  query: (sql: string, values: string[]) => Promise<{ rows: QueryResultRow[] }>;
};

const trendingSql = `WITH eligible_trades AS MATERIALIZED (
  SELECT e.token_address, e.wallet_address, e.transaction_hash, e.kind, e.occurred_at,
    e.quantity::numeric AS quantity, e.amount_usd::numeric AS amount_usd
  FROM fresh.financial_events e JOIN fresh.tokens t ON t.address=e.token_address
  WHERE e.observed_live AND e.provenance IS NULL
    AND e.occurred_at>$1::timestamptz AND e.occurred_at<=$2::timestamptz
    AND ${freshPublicTradeScopeSql('e')} AND ${freshTrackedEventSql('e','t')} AND ${kolProfileTokenSql('t')}
), participation AS MATERIALIZED (
  SELECT token_address, wallet_address, max(occurred_at) AS last_trade_at,
    count(*) FILTER (WHERE kind='buy')::int AS buy_count,
    count(*) FILTER (WHERE kind='sell')::int AS sell_count,
    bool_or(kind='buy' AND occurred_at>$3::timestamptz) AS recent_buyer,
    sum(amount_usd) FILTER (WHERE kind='buy' AND occurred_at>$3::timestamptz) AS recent_buy_usd,
    sum(amount_usd) AS volume_usd,
    bool_or(amount_usd IS NULL) AS volume_incomplete
  FROM eligible_trades GROUP BY token_address,wallet_address
), activity AS (
  SELECT token_address, count(*)::int AS kol_count, sum(buy_count)::int AS buy_count,
    sum(sell_count)::int AS sell_count, max(last_trade_at) AS last_public_trade_at,
    count(*) FILTER (WHERE recent_buyer)::int AS recent_buyers,
    sum(recent_buy_usd) AS recent_buy_usd,
    sum(volume_usd) AS volume_usd, bool_or(volume_incomplete) AS volume_incomplete
  FROM participation GROUP BY token_address HAVING count(*)>=2
), priced_transactions AS (
  -- Each confirmed transaction supplies at most one effective price. Ignore dust.
  SELECT e.token_address, e.transaction_hash, max(e.occurred_at) AS observed_at,
    min(e.wallet_address) AS first_wallet, max(e.wallet_address) AS last_wallet,
    sum(e.amount_usd)/sum(e.quantity) AS execution_price
  FROM eligible_trades e JOIN activity a USING (token_address)
  WHERE e.amount_usd>=5 AND e.quantity>0
  GROUP BY e.token_address,e.transaction_hash
), priced_spans AS (
  SELECT *,
    min(observed_at) OVER (PARTITION BY token_address) AS first_at,
    max(observed_at) OVER (PARTITION BY token_address) AS last_at
  FROM priced_transactions
), price_bands AS (
  -- Compare medians in the first and last thirds of the observed trading span.
  -- Each band needs independent transactions from at least two tracked wallets.
  SELECT token_address, band, percentile_disc(0.5) WITHIN GROUP (ORDER BY execution_price) AS price
  FROM (
    SELECT *, CASE
      WHEN observed_at<=first_at+(last_at-first_at)/3 THEN 'early'
      WHEN observed_at>=last_at-(last_at-first_at)/3 THEN 'late'
      END AS band
    FROM priced_spans
    WHERE last_at-first_at>=interval '30 seconds' AND last_at>$3::timestamptz
  ) spans
  WHERE band IS NOT NULL
  GROUP BY token_address,band HAVING count(*)>=3 AND min(first_wallet)<max(last_wallet)
), ranked AS (
  -- Recent buyer breadth leads the score. Cap volume and momentum contributions
  -- so repeated swaps and outliers cannot drown out broad participation.
  SELECT a.*, a.volume_usd::text AS display_volume_usd,
    8 * least(a.recent_buyers,12) + 3 * least(a.kol_count,16)
    + 5 * ln(1 + least(coalesce(a.recent_buy_usd,0),100000)/100)
    + 2 * ln(1 + least(coalesce(a.volume_usd,0),1000000)/100)
    + greatest(-20,least(20,coalesce(40 * (late.price/early.price - 1),0))) AS score
  FROM activity a
  LEFT JOIN price_bands early ON early.token_address=a.token_address AND early.band='early'
  LEFT JOIN price_bands late ON late.token_address=a.token_address AND late.band='late'
  ORDER BY score DESC,kol_count DESC,buy_count+sell_count DESC,last_public_trade_at DESC,token_address
  LIMIT 12
)
SELECT t.address,t.symbol,t.name,t.logo_url,(t.logo_data IS NOT NULL) AS logo_data,
  t.market_cap_usd,t.price_usd,t.observed_at,t.valuation_status,ranked.*,
  (SELECT jsonb_agg(jsonb_build_object(
      'walletAddress',p.wallet_address,
      'name',coalesce(nullif(k.display_name,''),left(p.wallet_address,6)||'…'||right(p.wallet_address,4)),
      'twitter',k.twitter
    ) ORDER BY p.last_trade_at DESC,p.wallet_address)
    FROM participation p JOIN published_kols k ON k.address=p.wallet_address
    WHERE p.token_address=ranked.token_address) AS kols
FROM ranked JOIN fresh.tokens t ON t.address=ranked.token_address
ORDER BY score DESC,kol_count DESC,buy_count+sell_count DESC,last_public_trade_at DESC,t.address`;

export async function readFreshTrendingTokens(db: TrendingDb, window: TrendingWindow, now = Date.now()): Promise<TrendingTokens> {
  const asOf = new Date(now).toISOString();
  const from = new Date(now - trendingWindows[window] * 60_000).toISOString();
  const recentFrom = new Date(now - Math.min(trendingWindows[window], 15) * 60_000).toISOString();
  const { rows } = await db.query(trendingSql, [from, asOf, recentFrom]);
  return {
    window, asOf,
    items: rows.map(row => {
      const { address, symbol, name, logoUrl, marketCapUsd } = freshTokenDirectoryIdentity(row, now);
      const kols = ((row.kols ?? []) as TrendingKol[]).map(kol => {
        const profile = kol.twitter?.trim().replace(/^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, '');
        const handle = profile?.match(/^@?([A-Za-z0-9_]{1,15})\/?$/)?.[1];
        const twitter = handle && !/^(?:home|explore|search|intent|i|share|settings|messages)$/i.test(handle) ? handle : null;
        return { ...kol, twitter };
      });
      return { address, symbol, name, logoUrl, marketCapUsd, kolCount: row.kol_count,
        volumeUsd: row.display_volume_usd, volumeIncomplete: row.volume_incomplete,
        buyCount: row.buy_count, sellCount: row.sell_count, kols, recentKols: kols.slice(0, 3).map(kol => kol.name) };
    }),
  };
}

export function registerFreshTrendingTokens(
  app: FastifyInstance,
  db: TrendingDb,
  readMarketMomentum?: (window: TrendingWindow) => Promise<MarketMomentumToken[]>,
) {
  const cache = new Map<TrendingWindow, { expiresAt: number; data: Promise<TrendingTokens> }>();
  app.get<{ Querystring: { window?: string; momentum?: string } }>('/api/extension/trending-tokens', async (request, reply) => {
    const window = request.query.window ?? defaultTrendingWindow;
    if (!isTrendingWindow(window)) return reply.code(400).send({ error: 'Invalid trending window' });
    const now = Date.now();
    let entry = cache.get(window);
    if (!entry || entry.expiresAt <= now) {
      const data = readFreshTrendingTokens(db, window, now);
      entry = { expiresAt: Infinity, data };
      const pending = entry;
      cache.set(window, pending);
      void data.then(() => { pending.expiresAt = Date.now() + 30_000; }, () => { cache.delete(window); });
    }
    if (request.query.momentum === '1' && readMarketMomentum) {
      const [data, momentum] = await Promise.all([
        entry.data,
        Promise.resolve().then(() => readMarketMomentum(window)).catch(() => []),
      ]);
      const addresses = new Set(data.items.map(item => item.address));
      const marketMomentum = momentum.filter(item => {
        if (addresses.has(item.address)) return false;
        addresses.add(item.address);
        return true;
      }).slice(0, 4);
      reply.header('Cache-Control', 'no-store');
      return marketMomentum.length ? { ...data, marketMomentum } : data;
    }
    reply.header('Cache-Control', 'public, max-age=30');
    return entry.data;
  });
}
