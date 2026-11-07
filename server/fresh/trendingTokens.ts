import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { defaultTrendingWindow, isTrendingWindow, trendingWindows, type TrendingTokens, type TrendingWindow } from '../../shared/trendingTokens.js';
import { kolProfileTokenSql } from '../kolProfileToken.js';
import { freshPublicTradeScopeSql } from './publicTokens.js';
import { freshTokenDirectoryIdentity } from './tokenDirectory.js';
import { freshTrackedEventSql } from './tracking.js';

const trendingSql = `WITH participation AS MATERIALIZED (
  SELECT e.token_address, e.wallet_address, max(e.occurred_at) AS last_trade_at,
    count(*) FILTER (WHERE e.kind='buy')::int AS buy_count,
    count(*) FILTER (WHERE e.kind='sell')::int AS sell_count,
    sum(e.amount_usd::numeric) AS volume_usd,
    bool_or(e.amount_usd IS NULL) AS volume_incomplete
  FROM fresh.financial_events e JOIN fresh.tokens t ON t.address=e.token_address
  WHERE e.observed_live AND e.provenance IS NULL
    AND e.occurred_at>$1::timestamptz AND e.occurred_at<=$2::timestamptz
    AND ${freshPublicTradeScopeSql('e')} AND ${freshTrackedEventSql('e','t')} AND ${kolProfileTokenSql('t')}
  GROUP BY e.token_address,e.wallet_address
), ranked AS (
  SELECT token_address, count(*)::int AS kol_count, sum(buy_count)::int AS buy_count,
    sum(sell_count)::int AS sell_count, max(last_trade_at) AS last_public_trade_at,
    sum(volume_usd)::text AS volume_usd, bool_or(volume_incomplete) AS volume_incomplete
  FROM participation GROUP BY token_address HAVING count(*)>=2
  ORDER BY kol_count DESC,sum(buy_count+sell_count) DESC,last_public_trade_at DESC,token_address
  LIMIT 12
)
SELECT t.address,t.symbol,t.name,t.logo_url,(t.logo_data IS NOT NULL) AS logo_data,
  t.market_cap_usd,t.price_usd,t.observed_at,t.valuation_status,ranked.*,
  ARRAY(SELECT coalesce(nullif(k.display_name,''),left(p.wallet_address,6)||'…'||right(p.wallet_address,4))
    FROM participation p JOIN published_kols k ON k.address=p.wallet_address
    WHERE p.token_address=ranked.token_address
    ORDER BY p.last_trade_at DESC,p.wallet_address LIMIT 3) AS recent_kols
FROM ranked JOIN fresh.tokens t ON t.address=ranked.token_address
ORDER BY kol_count DESC,buy_count+sell_count DESC,last_public_trade_at DESC,t.address`;

export async function readFreshTrendingTokens(db: Pick<Pool,'query'>, window: TrendingWindow, now = Date.now()): Promise<TrendingTokens> {
  const asOf = new Date(now).toISOString();
  const from = new Date(now - trendingWindows[window] * 60_000).toISOString();
  const { rows } = await db.query(trendingSql, [from, asOf]);
  return {
    window, asOf,
    items: rows.map(row => {
      const { address, symbol, name, logoUrl, marketCapUsd } = freshTokenDirectoryIdentity(row, now);
      return { address, symbol, name, logoUrl, marketCapUsd, kolCount: row.kol_count,
        volumeUsd: row.volume_usd, volumeIncomplete: row.volume_incomplete,
        buyCount: row.buy_count, sellCount: row.sell_count, recentKols: row.recent_kols };
    }),
  };
}

export function registerFreshTrendingTokens(app: FastifyInstance, db: Pick<Pool,'query'>) {
  const cache = new Map<TrendingWindow, { expiresAt: number; data: Promise<TrendingTokens> }>();
  app.get<{ Querystring: { window?: string } }>('/api/extension/trending-tokens', async (request, reply) => {
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
    reply.header('Cache-Control', 'public, max-age=30');
    return entry.data;
  });
}
