import type { TrendingMarketDetails, TrendingToken } from '../../shared/trendingTokens.js';
import type { Rpc } from '../rpc.js';
import { readGoPlusTrendingTax, readTrendingProviderJson } from './nodeMomentumDetails.js';
import { createNodeMomentumRpc } from './nodeMomentumRpc.js';
import { freshConfirmedPriceBlock, type FreshPriceBlock } from './pricing.js';
import { readTrendingMarketTax, trendingQuoteSymbol } from './settlementQuote.js';
import { createTrendingLaunchMarketReader, type TrendingLaunchMarketDetails, type TrendingLaunchMarketRequest } from './trendingLaunchMarket.js';

interface TrackedMarketContext {
  protocol?: TrendingLaunchMarketRequest['protocol'];
  quoteAddress?: string;
  marketAddress?: string;
  marketProtocol?: string;
}

type MarketLookup = {
  confirmedBlock: () => Promise<FreshPriceBlock>;
  read: (request: TrendingLaunchMarketRequest, block: FreshPriceBlock) => Promise<TrendingLaunchMarketDetails>;
};

const addressPattern = /^0x[0-9a-f]{40}$/;
const lowerAddress = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : undefined;
const hasTax = (value: TrendingMarketDetails) => value.buyTaxBps !== undefined || value.sellTaxBps !== undefined;
const hasBothRates = (value: TrendingMarketDetails) => value.buyTaxBps !== undefined && value.sellTaxBps !== undefined;
const defaultWaitMs = 1000;
const cacheLifetimeMs = 120_000;
const taxRefreshMs = 5 * 60_000;
const unavailableRetryMs = 60_000;
const batchCooldownMs = 5_000;
const maxBatchSize = 4;
const maxCachedMarkets = 128;

export function createLocalTrackedTrendingDetails() {
  const rpc = createNodeMomentumRpc(undefined, { deadlineMs: 750, allowCodeRead: true });
  // Keep a single local-node request active even when a reader requests several contract calls.
  let tail = Promise.resolve();
  const read: Rpc = <T>(method: string, params: unknown[]) => {
    const call = tail.then(() => rpc<T>(method, params));
    tail = call.then(() => {}, () => {});
    return call;
  };
  return createTrackedTrendingDetails({
    marketLookup: { confirmedBlock: () => freshConfirmedPriceBlock(read), read: createTrendingLaunchMarketReader(read) },
  });
}

type Candidate = { key: string; item: TrendingToken; market?: TrackedMarketContext };
type IndexedPool = {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
};

function bestIndexedQuote(pools: IndexedPool[], candidate: Candidate) {
  const { market, item } = candidate;
  let best: { symbol: string; liquidity: number; pair: string } | undefined;
  for (const pool of pools) {
    if (pool?.chainId !== 'bsc') continue;
    const pair = typeof pool.pairAddress === 'string' ? pool.pairAddress.toLowerCase() : '';
    if (!addressPattern.test(pair) || (market?.marketAddress && market.marketAddress !== pair)) continue;
    const matchesBase = lowerAddress(pool.baseToken?.address) === item.address;
    const matchesQuote = lowerAddress(pool.quoteToken?.address) === item.address;
    if (matchesBase === matchesQuote) continue;
    const counter = matchesBase ? pool.quoteToken : pool.baseToken;
    const counterAddress = lowerAddress(counter?.address);
    if (market?.quoteAddress && market.quoteAddress !== counterAddress) continue;
    const symbol = trendingQuoteSymbol(counterAddress, counter?.symbol);
    const liquidity = pool.liquidity?.usd;
    if (!symbol || typeof liquidity !== 'number' || !Number.isFinite(liquidity) || liquidity <= 0) continue;
    if (!best || liquidity > best.liquidity || (liquidity === best.liquidity && pair < best.pair)) {
      best = { symbol, liquidity, pair };
    }
  }
  return best?.symbol;
}

/** Bound cold lookups across all windows and keep provider data display-only. */
export function createTrackedTrendingDetails({
  marketLookup, fetcher = fetch, now = Date.now, waitMs = defaultWaitMs,
}: { marketLookup?: MarketLookup; fetcher?: typeof fetch; now?: () => number; waitMs?: number } = {}) {
  const cache = new Map<string, { details: TrendingMarketDetails; taxExpiresAt?: number; expiresAt: number }>();
  let inFlight: Promise<void> | undefined;
  let lastBatchAt = -Infinity;

  async function refresh(candidates: Candidate[]) {
    const pairAddresses = candidates.filter(({ item }) => !item.quoteSymbol).map(({ item }) => item.address);
    const pairs = pairAddresses.length
      ? readTrendingProviderJson('https://api.dexscreener.com/tokens/v1/bsc/' + [...new Set(pairAddresses)].join(','), fetcher)
        .then(result => Array.isArray(result) ? result as IndexedPool[] : []).catch(() => [])
      : Promise.resolve([]);
    const hasLaunch = candidates.some(({ market }) => market?.protocol);
    const block = hasLaunch ? await marketLookup?.confirmedBlock().catch(() => undefined) : undefined;

    await Promise.all(candidates.map(async ({ key, item, market }) => {
      const details: TrendingMarketDetails = {};
      let taxExpiresAt: number | undefined;
      if (market?.protocol && block && marketLookup) {
        const observed: TrendingLaunchMarketDetails = await marketLookup.read({ ...market, protocol: market.protocol, address: item.address }, block).catch(() => ({}));
        if (observed.quoteSymbol) details.quoteSymbol = observed.quoteSymbol;
        const tax = readTrendingMarketTax(observed, now() + 30_000);
        if (hasTax(tax)) {
          Object.assign(details, tax, { taxAsOf: block.timestamp });
          taxExpiresAt = observed.expiresAtSeconds === undefined ? undefined : observed.expiresAtSeconds * 1000;
        }
      }
      if (!item.quoteSymbol && !details.quoteSymbol) {
        const source = bestIndexedQuote(await pairs, { key, item, market });
        if (source) Object.assign(details, { quoteSymbol: source, quoteSource: 'dexscreener' } as const);
      }
      if (!market?.protocol && !hasTax(item)) {
        const tax = await readGoPlusTrendingTax(item.address, fetcher);
        if (hasTax(tax)) Object.assign(details, tax, { taxSource: 'goplus' } as const);
      }
      const age = details.quoteSymbol || hasTax(details) ? cacheLifetimeMs : unavailableRetryMs;
      cache.delete(key);
      cache.set(key, { details, taxExpiresAt, expiresAt: now() + age });
      if (cache.size > maxCachedMarkets) cache.delete(cache.keys().next().value!);
    }));
  }

  return async (items: TrendingToken[], markets: ReadonlyMap<string, TrackedMarketContext>): Promise<TrendingToken[]> => {
    const candidates = items.flatMap(item => {
      const market = markets.get(item.address);
      const staleTax = market?.protocol && item.taxAsOf && now() - Date.parse(item.taxAsOf) >= taxRefreshMs;
      if ((item.quoteSymbol && hasBothRates(item) && !staleTax) || !addressPattern.test(item.address)) return [];
      const key = JSON.stringify([item.address, market?.protocol, market?.marketAddress, market?.marketProtocol, market?.quoteAddress]);
      return [{ key, item, market }];
    });
    if (!inFlight && now() - lastBatchAt >= batchCooldownMs) {
      const due = candidates.filter(({ key }) => (cache.get(key)?.expiresAt ?? 0) <= now())
        .sort((a, b) => (cache.get(a.key)?.expiresAt ?? 0) - (cache.get(b.key)?.expiresAt ?? 0)
          || Number(Boolean(b.market?.protocol)) - Number(Boolean(a.market?.protocol))
          || Number(Boolean(a.item.quoteSymbol)) - Number(Boolean(b.item.quoteSymbol)))
        .slice(0, maxBatchSize);
      if (due.length) {
        lastBatchAt = now();
        inFlight = refresh(due).catch(() => {}).finally(() => { inFlight = undefined; });
      }
    }
    if (inFlight && candidates.some(({ key, item }) => !cache.has(key) && (!item.quoteSymbol || !hasBothRates(item)))) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([inFlight, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      } finally {
        clearTimeout(timer);
      }
    }
    const enriched = new Map(candidates.map(candidate => {
      const { key, item } = candidate;
      const entry = cache.get(key);
      if (!entry || entry.expiresAt <= now()) return [item.address, item] as const;
      const { quoteSymbol, quoteSource, buyTaxBps, sellTaxBps, taxSource, taxAsOf } = entry.details;
      const stillApplies = entry.taxExpiresAt === undefined || entry.taxExpiresAt > now() + 30_000;
      // Only replace a stored rate with a newer, complete same-market read.
      const newerOnChain = taxAsOf && (!item.taxAsOf || Date.parse(taxAsOf) > Date.parse(item.taxAsOf));
      const useTax = stillApplies && (!hasTax(item) || (newerOnChain && hasBothRates(entry.details)));
      return [item.address, { ...item,
        ...(!item.quoteSymbol && quoteSymbol ? { quoteSymbol, ...(quoteSource ? { quoteSource } : {}) } : {}),
        ...(useTax && hasTax(entry.details) ? {
          ...(buyTaxBps !== undefined ? { buyTaxBps } : {}),
          ...(sellTaxBps !== undefined ? { sellTaxBps } : {}),
          ...(taxSource ? { taxSource } : {}),
          ...(taxAsOf ? { taxAsOf } : {}),
        } : {}),
      }] as const;
    }));
    return items.map(item => enriched.get(item.address) ?? item);
  };
}
