import type { Pool } from 'pg';
import { trendingWindows, type MarketMomentumToken, type TrendingWindow } from '../../shared/trendingTokens.js';
import { readTrendingMarketTax, trendingQuoteSymbol } from './settlementQuote.js';

const minute = 60_000;
const day = 24 * 60 * minute;
const windowKeys = Object.keys(trendingWindows) as TrendingWindow[];
const snapshotLimit = 16;
const maxSnapshotAge = 3 * minute;
const maxMarketsSupported = 128;
const addressPattern = /^0x[0-9a-f]{40}$/;
const hashPattern = /^0x[0-9a-f]{64}$/;
const usdPattern = /^[0-9]+(?:\.[0-9]+)?$/;
const decimalUsd = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 12 });
export const nodeMomentumCheckpoint = 'extension:node_market_momentum';
const activity: Record<TrendingWindow, { volume: number; buys: number; transactions: number }> = {
  '5m': { volume: 500, buys: 5, transactions: 7 },
  '15m': { volume: 1_500, buys: 8, transactions: 10 },
  '30m': { volume: 2_500, buys: 10, transactions: 12 },
  '1h': { volume: 5_000, buys: 15, transactions: 17 },
  '6h': { volume: 15_000, buys: 25, transactions: 27 },
  '24h': { volume: 30_000, buys: 40, transactions: 42 },
};

export interface NodeMomentumSwap {
  poolAddress: string;
  tokenAddress: string;
  quoteAddress: string;
  name: string;
  symbol: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  at: number;
  side: 'buy' | 'sell';
  volumeUsd: number;
  priceUsd: number | null;
  marketCapUsd?: number | null;
}

export interface NodeMomentumRange {
  fromBlock: number;
  blockNumber: number;
  parentHash: string;
  blockHash: string;
  observedAt: number;
  swaps: readonly NodeMomentumSwap[];
  /** Optional explicit roster. A pool must stay in the roster to accrue coverage. */
  coveredPools?: readonly string[];
}

type NodeMomentumSnapshotItem = MarketMomentumToken & {
  // Optional for snapshots written by an older worker.
  poolAddress?: string;
  quoteAddress?: string;
};

export interface NodeMomentumSnapshot {
  version: 1;
  source: 'bnb_node';
  blockNumber: number;
  blockHash: string;
  observedAtMs: number;
  asOfMs: number;
  /** All blocks after this baseline are covered for the selected pools. */
  coveredFromMs: number;
  windows: Partial<Record<TrendingWindow, NodeMomentumSnapshotItem[]>>;
}

interface MomentumBucket {
  volume: number;
  buyCount: number;
  sellCount: number;
  transactions: number;
  priceWeight: number;
  weightedPrice: number;
  pricedTransactions: number;
  lastPricedAt: number;
  marketCapUsd: number | null;
}

interface MomentumMarket {
  address: string;
  quote: string;
  name: string;
  symbol: string;
  from: number;
  lastAt: number;
  buckets: Map<number, MomentumBucket>;
}

const minuteStart = (at: number) => Math.floor(at / minute) * minute;
const validTime = (at: number) => Number.isSafeInteger(at) && at >= 0 && at <= 8.64e15;
const validIndex = (value: number) => Number.isSafeInteger(value) && value >= 0;
const positive = (value: number) => Number.isFinite(value) && value > 0;
const validObservation = (value: number) => positive(value) && value <= 1e18;
const safeIdentity = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);

export function createNodeMomentumStore({ coverageStartMs, maxMarkets = maxMarketsSupported }: {
  coverageStartMs: number;
  maxMarkets?: number;
}) {
  if (!validTime(coverageStartMs) || !Number.isInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > maxMarketsSupported) {
    throw Error('invalid_node_momentum_configuration');
  }

  const markets = new Map<string, MomentumMarket>();
  let coverageStart = coverageStartMs;
  let tip: { blockNumber: number; blockHash: string; observedAt: number } | undefined;
  let roster: Map<string, number> | undefined;
  // A pool skipped at capacity cannot later claim the original baseline.
  let fullRosterAt: number | undefined;

  function appendRange(range: NodeMomentumRange) {
    if (!validIndex(range.fromBlock) || range.fromBlock < 1 || !validIndex(range.blockNumber)
      || range.blockNumber < range.fromBlock || range.blockNumber - range.fromBlock >= 8_192
      || !hashPattern.test(range.blockHash) || !hashPattern.test(range.parentHash)
      || !validTime(range.observedAt) || range.observedAt < (tip?.observedAt ?? coverageStart)
      || range.swaps.length > 65_536) throw Error('invalid_node_momentum_range');
    if (tip && (range.fromBlock !== tip.blockNumber + 1 || range.parentHash !== tip.blockHash)) {
      throw Error('node_momentum_range_discontinuous');
    }
    const covered = range.coveredPools && new Set(range.coveredPools);
    if (covered && (covered.size > maxMarkets || [...covered].some(pool => !addressPattern.test(pool)))) {
      throw Error('invalid_node_momentum_roster');
    }
    if (tip && Boolean(roster) !== Boolean(covered)) throw Error('node_momentum_roster_mode_changed');

    const identities = new Map<string, string>();
    const start = tip?.observedAt ?? coverageStart;
    let previous: NodeMomentumSwap | undefined;
    for (const swap of range.swaps) {
      if (!addressPattern.test(swap.poolAddress) || !addressPattern.test(swap.tokenAddress) || !addressPattern.test(swap.quoteAddress)
        || swap.tokenAddress === swap.quoteAddress || !hashPattern.test(swap.blockHash) || !hashPattern.test(swap.transactionHash)
        || !validIndex(swap.blockNumber) || swap.blockNumber < range.fromBlock || swap.blockNumber > range.blockNumber
        || swap.blockNumber === range.blockNumber && swap.blockHash !== range.blockHash
        || !validIndex(swap.logIndex) || !validIndex(swap.transactionIndex) || !validTime(swap.at) || swap.at < start
        || swap.at > range.observedAt || swap.blockNumber === range.blockNumber && swap.at !== range.observedAt
        || !validObservation(swap.volumeUsd) || swap.priceUsd !== null && !positive(swap.priceUsd)
        || (swap.side !== 'buy' && swap.side !== 'sell') || typeof swap.name !== 'string' || typeof swap.symbol !== 'string'
        || covered && !covered.has(swap.poolAddress)) throw Error('invalid_node_momentum_swap');
      if (previous && (swap.blockNumber < previous.blockNumber || swap.at < previous.at
        || swap.blockNumber === previous.blockNumber && (swap.blockHash !== previous.blockHash || swap.at !== previous.at
          || swap.logIndex <= previous.logIndex || swap.transactionIndex < previous.transactionIndex
          || (swap.transactionIndex === previous.transactionIndex) !== (swap.transactionHash === previous.transactionHash)))) {
        throw Error('node_momentum_swap_order_invalid');
      }
      previous = swap;
      const identity = swap.tokenAddress + swap.quoteAddress;
      const saved = markets.get(swap.poolAddress);
      const priorIdentity = identities.get(swap.poolAddress) ?? (saved ? saved.address + saved.quote : undefined);
      if (priorIdentity && priorIdentity !== identity) throw Error('node_momentum_pool_identity_changed');
      identities.set(swap.poolAddress, identity);
    }

    if (covered) {
      const nextRoster = new Map<string, number>();
      for (const pool of covered) nextRoster.set(pool, roster?.get(pool) ?? start);
      for (const pool of markets.keys()) if (!covered.has(pool)) markets.delete(pool);
      roster = nextRoster;
    }

    const expiredBefore = minuteStart(range.observedAt) - day;
    for (const [pool, market] of markets) {
      for (const bucket of market.buckets.keys()) {
        if (bucket >= expiredBefore) break;
        market.buckets.delete(bucket);
      }
      if (!market.buckets.size) markets.delete(pool);
    }

    const transactionPools = new Set<string>();
    const pricedTransactionPools = new Set<string>();
    let transaction = '';
    for (const swap of range.swaps) {
      const bucketAt = minuteStart(swap.at);
      if (bucketAt < expiredBefore) continue;
      if (swap.transactionHash !== transaction) {
        transaction = swap.transactionHash;
        transactionPools.clear();
        pricedTransactionPools.clear();
      }
      let market = markets.get(swap.poolAddress);
      if (!market) {
        if (markets.size >= maxMarkets) {
          fullRosterAt ??= swap.at;
          continue;
        }
        market = {
          address: swap.tokenAddress, quote: swap.quoteAddress,
          name: safeIdentity(swap.name, 80), symbol: safeIdentity(swap.symbol, 30),
          from: roster?.get(swap.poolAddress) ?? (fullRosterAt === undefined ? coverageStart : swap.at),
          lastAt: swap.at, buckets: new Map(),
        };
        markets.set(swap.poolAddress, market);
      }
      const bucket = market.buckets.get(bucketAt) ?? {
        volume: 0, buyCount: 0, sellCount: 0, transactions: 0,
        priceWeight: 0, weightedPrice: 0, pricedTransactions: 0, lastPricedAt: 0, marketCapUsd: null,
      };
      bucket.volume += swap.volumeUsd;
      if (swap.side === 'buy') bucket.buyCount++;
      else bucket.sellCount++;
      if (!transactionPools.has(swap.poolAddress)) bucket.transactions++;
      transactionPools.add(swap.poolAddress);
      // Take one non-dust spot observation per pool per transaction.
      if (swap.volumeUsd >= 5 && swap.priceUsd !== null && validObservation(swap.priceUsd)
        && !pricedTransactionPools.has(swap.poolAddress)) {
        const weight = Math.min(swap.volumeUsd, 250);
        bucket.priceWeight += weight;
        bucket.weightedPrice += weight * swap.priceUsd;
        bucket.pricedTransactions++;
        bucket.lastPricedAt = swap.at;
        pricedTransactionPools.add(swap.poolAddress);
      }
      bucket.marketCapUsd = typeof swap.marketCapUsd === 'number' && validObservation(swap.marketCapUsd) ? swap.marketCapUsd : null;
      market.buckets.set(bucketAt, bucket);
      market.lastAt = swap.at;
    }
    tip = { blockNumber: range.blockNumber, blockHash: range.blockHash, observedAt: range.observedAt };
  }

  function snapshot(): NodeMomentumSnapshot | null {
    if (!tip) return null;
    const { asOfMs } = cursor()!;
    const windows: NodeMomentumSnapshot['windows'] = {};
    for (const window of windowKeys) {
      const from = asOfMs - trendingWindows[window] * minute;
      if (from <= coverageStart) continue;
      windows[window] = rankNodeMomentum(markets, window, from, asOfMs);
    }
    return {
      version: 1, source: 'bnb_node', blockNumber: tip.blockNumber, blockHash: tip.blockHash,
      observedAtMs: tip.observedAt, asOfMs, coveredFromMs: coverageStart, windows,
    };
  }

  function cursor() {
    return tip ? { ...tip, asOfMs: minuteStart(tip.observedAt) } : null;
  }

  return {
    appendRange,
    append(block: Omit<NodeMomentumRange, 'fromBlock'>) { appendRange({ ...block, fromBlock: block.blockNumber }); },
    snapshot,
    cursor,
    reset(at: number) {
      if (!validTime(at)) throw Error('invalid_node_momentum_configuration');
      coverageStart = at;
      tip = undefined;
      roster = undefined;
      fullRosterAt = undefined;
      markets.clear();
    },
    stats() {
      return { markets: markets.size, buckets: [...markets.values()].reduce((sum, market) => sum + market.buckets.size, 0) };
    },
  };
}

function rankNodeMomentum(markets: Map<string, MomentumMarket>, window: TrendingWindow, from: number, asOf: number) {
  const minimum = activity[window];
  const bandMs = Math.max(minute, (asOf - from) / 3);
  const ranked = new Map<string, { item: NodeMomentumSnapshotItem; score: number; volume: number; pool: string }>();
  for (const [pool, market] of markets) {
    if (market.from >= from || market.lastAt < asOf - Math.min(15 * minute, asOf - from)) continue;
    let volume = 0, buyCount = 0, sellCount = 0, transactions = 0;
    let earlyWeight = 0, earlyPrice = 0, earlyTrades = 0, lateWeight = 0, latePrice = 0, lateTrades = 0, lastPricedAt = 0;
    let marketCapUsd: number | null = null;
    for (const [at, bucket] of market.buckets) {
      if (at < from) continue;
      if (at >= asOf) break;
      volume += bucket.volume;
      buyCount += bucket.buyCount;
      sellCount += bucket.sellCount;
      transactions += bucket.transactions;
      marketCapUsd = bucket.marketCapUsd;
      if (at < from + bandMs) {
        earlyWeight += bucket.priceWeight;
        earlyPrice += bucket.weightedPrice;
        earlyTrades += bucket.pricedTransactions;
      } else if (at >= asOf - bandMs) {
        lateWeight += bucket.priceWeight;
        latePrice += bucket.weightedPrice;
        lateTrades += bucket.pricedTransactions;
        lastPricedAt = Math.max(lastPricedAt, bucket.lastPricedAt);
      }
    }
    if (lastPricedAt < asOf - Math.min(15 * minute, asOf - from) || earlyTrades < 2 || lateTrades < 2
      || volume < minimum.volume || buyCount < minimum.buys || sellCount < 2 || transactions < minimum.transactions) continue;
    const priceChangePct = ((latePrice / lateWeight) / (earlyPrice / earlyWeight) - 1) * 100;
    if (!Number.isFinite(priceChangePct) || priceChangePct < 2) continue;
    const score = Math.log1p(Math.min(transactions / minimum.transactions, 100))
      + Math.log1p(Math.min(volume / minimum.volume, 100)) + Math.log1p(Math.min(priceChangePct, 200) / 10);
    const quoteSymbol = trendingQuoteSymbol(market.quote);
    const item = {
      address: market.address, name: market.name || market.symbol, symbol: market.symbol || market.name.slice(0, 30),
      poolAddress: pool, quoteAddress: market.quote,
      marketCapUsd: marketCapUsd === null || marketCapUsd < 0.000000000001 ? null : decimalUsd.format(marketCapUsd),
      volumeUsd: decimalUsd.format(volume), priceChangePct, buyCount, sellCount,
      ...(quoteSymbol === undefined ? {} : { quoteSymbol }),
    };
    if (!item.name) continue;
    const prior = ranked.get(item.address);
    // Use a single representative pool to avoid counting the same route twice.
    if (!prior || volume > prior.volume || volume === prior.volume && pool < prior.pool) {
      ranked.set(item.address, { item, score, volume, pool });
    }
  }
  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || b.volume - a.volume || a.item.address.localeCompare(b.item.address))
    .slice(0, snapshotLimit)
    .map(({ item }) => item);
}

const canonicalSnapshotSql = `FROM fresh.checkpoints c
  JOIN fresh.recent_blocks h ON h.block_number=$2::bigint AND h.block_hash=$3
    AND h.occurred_at=to_timestamp($4::double precision/1000)
  WHERE c.key='capture' AND c.block_number>=h.block_number AND c.revision=$5::bigint FOR SHARE OF c`;

export async function persistNodeMomentumSnapshot(db: Pick<Pool, 'query'>, snapshot: NodeMomentumSnapshot, captureRevision: string | number) {
  const revision = String(captureRevision);
  if (!/^\d{1,18}$/.test(revision) || !validSnapshot(snapshot)) throw Error('invalid_node_momentum_snapshot');
  const value = { ...snapshot, captureRevision: revision };
  const result = await db.query(`
    INSERT INTO fresh.checkpoints AS current(key,block_number,block_hash,value)
    SELECT $1,h.block_number,h.block_hash,$6::jsonb
    ${canonicalSnapshotSql}
    ON CONFLICT(key) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,
      value=EXCLUDED.value,updated_at=clock_timestamp()
    WHERE current.value->>'captureRevision' IS DISTINCT FROM EXCLUDED.value->>'captureRevision'
      OR (current.block_number<EXCLUDED.block_number AND current.value->>'asOfMs' IS DISTINCT FROM EXCLUDED.value->>'asOfMs')`,
  [nodeMomentumCheckpoint, snapshot.blockNumber, snapshot.blockHash, snapshot.observedAtMs, revision, JSON.stringify(value)]);
  return result.rowCount === 1;
}

function validSnapshot(value: NodeMomentumSnapshot | null | undefined): value is NodeMomentumSnapshot {
  if (!value || value.version !== 1 || value.source !== 'bnb_node' || !validIndex(value.blockNumber)
    || !hashPattern.test(value.blockHash) || !validTime(value.observedAtMs) || !validTime(value.asOfMs)
    || !validTime(value.coveredFromMs) || value.coveredFromMs > value.observedAtMs
    || value.asOfMs !== minuteStart(value.observedAtMs) || !value.windows || typeof value.windows !== 'object'
    || Array.isArray(value.windows)) return false;
  return Object.entries(value.windows).every(([window, items]) => {
    if (!Object.hasOwn(trendingWindows, window) || !Array.isArray(items) || items.length > snapshotLimit) return false;
    if (value.asOfMs - trendingWindows[window as TrendingWindow] * minute <= value.coveredFromMs) return false;
    return items.every(validSnapshotItem) && new Set(items.map(item => item.address)).size === items.length;
  });
}

function validSnapshotItem(item: NodeMomentumSnapshotItem) {
  return item && typeof item.address === 'string' && addressPattern.test(item.address)
    && typeof item.name === 'string' && item.name === safeIdentity(item.name, 80)
    && item.name.length > 0 && typeof item.symbol === 'string' && item.symbol === safeIdentity(item.symbol, 30)
    && (item.quoteSymbol === undefined || (typeof item.quoteSymbol === 'string' && /^[A-Za-z0-9]{1,16}$/.test(item.quoteSymbol)))
    && (item.poolAddress === undefined && item.quoteAddress === undefined
      || typeof item.poolAddress === 'string' && addressPattern.test(item.poolAddress)
      && typeof item.quoteAddress === 'string' && addressPattern.test(item.quoteAddress) && item.quoteAddress !== item.address)
    && positiveUsd(item.volumeUsd) && (item.marketCapUsd === null || positiveUsd(item.marketCapUsd))
    && Number.isFinite(item.priceChangePct) && item.priceChangePct >= 2 && validIndex(item.buyCount) && validIndex(item.sellCount);
}

function positiveUsd(value: unknown) {
  return typeof value === 'string' && value.length <= 60 && usdPattern.test(value) && positive(Number(value));
}

export async function readNodeMomentumSnapshot(db: Pick<Pool, 'query'>, window: TrendingWindow, now = Date.now()): Promise<MarketMomentumToken[]> {
  if (!validTime(now)) return [];
  const { rows } = await db.query(`SELECT s.value,s.block_number,s.block_hash,h.occurred_at,c.revision::text AS capture_revision
    FROM fresh.checkpoints s JOIN fresh.recent_blocks h ON h.block_number=s.block_number AND h.block_hash=s.block_hash
    JOIN fresh.checkpoints c ON c.key='capture' AND c.block_number>=s.block_number AND c.revision::text=s.value->>'captureRevision'
    WHERE s.key=$1 AND h.occurred_at BETWEEN $2 AND $3`,
  [nodeMomentumCheckpoint, new Date(now - maxSnapshotAge), new Date(now)]);
  const row = rows[0];
  const snapshot = row?.value as NodeMomentumSnapshot | undefined;
  if (!validSnapshot(snapshot) || snapshot.blockNumber !== Number(row.block_number) || snapshot.blockHash !== row.block_hash
    || snapshot.observedAtMs !== new Date(row.occurred_at).getTime() || snapshot.asOfMs > now || now - snapshot.asOfMs > maxSnapshotAge) return [];
  const items = snapshot.windows[window] ?? [];
  const markets = items.filter(item => item.poolAddress !== undefined);
  const taxes = new Map<string, unknown>();
  if (markets.length) {
    // Only use fresh evidence for the exact pool represented in the feed.
    // Another pool with the same token and quote may enforce a different tax.
    const observations = await db.query(`
      SELECT m.token_address,m.identity->'tokenTax' AS tax
      FROM unnest($1::text[],$2::text[],$3::text[]) candidate(token_address,pool_address,quote_address)
      JOIN fresh.tokens t ON t.address=candidate.token_address AND t.valuation_status='ready'
      JOIN fresh.markets m ON m.token_address=t.address AND m.address=candidate.pool_address
        AND m.quote_address=candidate.quote_address AND m.protocol='pcs_v3' AND m.status='ready'
        AND m.observed_block=t.observed_block AND m.observed_hash=t.observed_hash AND m.observed_at=t.observed_at
      JOIN fresh.checkpoints c ON c.key='capture' AND c.revision::text=$6
      JOIN fresh.recent_blocks h ON h.block_number=m.observed_block AND h.block_hash=m.observed_hash
        AND h.occurred_at=m.observed_at AND c.block_number>=h.block_number
      WHERE m.observed_at BETWEEN $4 AND $5 AND m.identity ? 'tokenTax'
        AND m.identity->'canonicalIdentityInvalid' IS DISTINCT FROM 'true'::jsonb
        AND m.identity#>'{market,canonicalIdentityInvalid}' IS DISTINCT FROM 'true'::jsonb`,
    [markets.map(item => item.address), markets.map(item => item.poolAddress), markets.map(item => item.quoteAddress),
      new Date(now - 2 * minute), new Date(now), row.capture_revision]).catch(() => null);
    for (const observation of observations?.rows ?? []) taxes.set(observation.token_address, observation.tax);
  }
  return items.map(({ poolAddress, quoteAddress, buyTaxBps, sellTaxBps, ...item }) => ({
    ...item,
    ...readTrendingMarketTax(taxes.get(item.address), now),
  }));
}
