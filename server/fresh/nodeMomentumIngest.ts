import { Interface, ZeroAddress, decodeBytes32String } from 'ethers';
import { PCS_V3_FACTORY } from '../launchpad.js';
import { isKolProfileToken } from '../kolProfileToken.js';
import { abs, MarketDecimal } from '../nodeMarketMath.js';
import { oracleMarketAbi, poolMarketAbi, TRUSTED_QUOTE_FEEDS, v3MarketAbi, type NodeMarketLog } from '../nodeMarketProtocols.js';
import { blockHex, rpcBatch, RpcRequestError, type Rpc } from '../rpc.js';
import type { FreshPriceBlock } from './pricing.js';
import { NodeMomentumLogRangeLimitError } from './nodeMomentumRpc.js';

export const NODE_MOMENTUM_MAX_RANGE = 128;
export const NODE_MOMENTUM_MAX_POOLS = 64;
export const NODE_MOMENTUM_MAX_LOGS = 4_096;
export const NODE_MOMENTUM_MAX_SCAN_LOGS = 8_192;
export const NODE_MOMENTUM_V3_SWAP_TOPIC = v3MarketAbi.getEvent('Swap')!.topicHash;

const maxLogRequests = 8;
const logBudgetMs = 5_000;
const tokenAbi = new Interface(['function decimals() view returns(uint8)', 'function name() view returns(string)', 'function symbol() view returns(string)']);
const legacyAbi = new Interface(['function name() view returns(bytes32)', 'function symbol() view returns(bytes32)']);
const identityTtlMs = 60 * 60_000;
const identityRefreshAheadMs = 5 * 60_000;
const pendingTtlMs = 30 * 60_000;
const verifiedLimit = 128;
const addressPattern = /^0x[0-9a-f]{40}$/;
const hashPattern = /^0x[0-9a-f]{64}$/;
const hexQuantity = /^0x(?:0|[1-9a-f][0-9a-f]{0,12})$/;
const safeUint = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const asAddress = (v: unknown) => typeof v === 'string' && addressPattern.test(v.toLowerCase()) ? v.toLowerCase() : null;
const quantity = (n: unknown) => typeof n === 'string' && hexQuantity.test(n) ? Number(BigInt(n)) : NaN;
const knownQuote = (address: string) => Object.hasOwn(TRUSTED_QUOTE_FEEDS, address);

export type MomentumBlock = FreshPriceBlock;
export interface MomentumSwap {
  poolAddress: string; tokenAddress: string; quoteAddress: string; name: string; symbol: string;
  blockNumber: number; blockHash: string; transactionHash: string; transactionIndex: number; logIndex: number;
  at: number; side: 'buy' | 'sell'; volumeUsd: number; priceUsd: number | null;
}
export interface MomentumScanStats {
  logs: number; emitters: number; decoded: number; identitiesAttempted: number;
  identitiesVerified: number; pendingIdentities: number; coveredPools: number; unpricedPools: number;
  quoteBlocksRead: number;
  logRequests?: number; logSplits?: number;
}
export interface MomentumScanResult { observations: MomentumSwap[]; coveredPools: string[]; stats: MomentumScanStats }
export interface VerifiedMomentumPool {
  poolAddress: string; tokenAddress: string; quoteAddress: string; name: string; symbol: string;
  tokenIs0: boolean; decimals0: number; decimals1: number;
}
interface Anchor { block: MomentumBlock; at: number; round: bigint; updatedAt: number; priceUsd: string }
interface PendingIdentity { firstBlock: number; lastBlock: number; lastAt: number; nextBlock: number; score: number }
interface LogRow { log: NodeMarketLog; block: MomentumBlock; logIndex: number; transactionIndex: number }
type StateCall = { address: string; abi: Interface; method: string; args?: unknown[] };
type StateResult = Awaited<ReturnType<typeof readState>>[number];

function validBlock(block: MomentumBlock) {
  return !!block && safeUint(block.number) && hashPattern.test(block.hash) && Number.isFinite(Date.parse(block.timestamp));
}

async function readState(rpc: Rpc, block: MomentumBlock, calls: readonly StateCall[]) {
  const rows = await rpcBatch<string>(rpc, calls.map(({ address, abi, method, args }) => ({
    method: 'eth_call',
    params: [{ to: address, data: abi.encodeFunctionData(method, args ?? []) }, { blockHash: block.hash, requireCanonical: true }],
  })));
  return rows.map((row, index) => {
    if (row.status === 'rejected') return { raw: null, value: null, retryable: !(row.reason instanceof RpcRequestError && row.reason.category === 'revert') };
    const raw = row.value, { abi, method } = calls[index];
    if (typeof raw !== 'string' || raw.length > 2_050 || !/^0x(?:[a-f0-9]{2})*$/.test(raw)) return { raw: null, value: null, retryable: false };
    try {
      const value = abi.decodeFunctionResult(method, raw);
      return { raw, value: abi.encodeFunctionResult(method, value) === raw ? value : null, retryable: false };
    } catch { return { raw, value: null, retryable: false }; }
  });
}

function readText(row: StateResult, field: 'name' | 'symbol', limit: number) {
  try {
    const value = row.value?.[0] ?? (row.raw ? decodeBytes32String(legacyAbi.decodeFunctionResult(field, row.raw)[0]) : '');
    return String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit);
  } catch { return ''; }
}

function precision(row: StateResult) {
  const n = Number(row.value?.[0]);
  return safeUint(n) && n <= 36 ? n : null;
}

/** Prove the emitter through the deployed factory, then read ERC20 precision
 * and display identity at the same confirmed block. Pool and token admission
 * here have no relationship to the accounting ledger's launch boundary. */
async function authenticatePools(rpc: Rpc, block: MomentumBlock, pools: readonly string[], checkBudget: () => void) {
  const first = await readState(rpc, block, pools.flatMap(address => ['factory', 'token0', 'token1', 'fee']
    .map(method => ({ address, abi: poolMarketAbi, method }))));
  checkBudget();
  const results = new Map<string, VerifiedMomentumPool | 'rejected' | 'retry'>();
  const tentative = pools.flatMap((poolAddress, index) => {
    const rows = first.slice(index * 4, index * 4 + 4);
    const [factory, token0, token1] = rows.slice(0, 3).map(row => asAddress(row.value?.[0]));
    const fee = Number(rows[3].value?.[0]);
    if (rows.some(row => row.retryable)) { results.set(poolAddress, 'retry'); return []; }
    if (factory !== PCS_V3_FACTORY || !token0 || !token1 || token0 === ZeroAddress || token0 >= token1 ||
        !safeUint(fee) || fee >= 1_000_000 || knownQuote(token0) === knownQuote(token1)) {
      results.set(poolAddress, 'rejected'); return [];
    }
    const tokenIs0 = knownQuote(token1);
    return [{ poolAddress, token0, token1, tokenIs0, fee, tokenAddress: tokenIs0 ? token0 : token1, quoteAddress: tokenIs0 ? token1 : token0 }];
  });
  const factoryRows = await readState(rpc, block, tentative.map(({ token0, token1, fee }) => ({
    address: PCS_V3_FACTORY, abi: poolMarketAbi, method: 'getPool', args: [token0, token1, fee],
  })));
  checkBudget();
  const proven = tentative.filter((pool, index) => {
    const row = factoryRows[index];
    if (asAddress(row.value?.[0]) === pool.poolAddress) return true;
    results.set(pool.poolAddress, row.retryable ? 'retry' : 'rejected');
    return false;
  });
  const tokens = [...new Set(proven.flatMap(pool => [pool.tokenAddress, pool.quoteAddress]))];
  const metadataRows = await readState(rpc, block, tokens.flatMap(address => (knownQuote(address) ? ['decimals'] : ['decimals', 'name', 'symbol'])
    .map(method => ({ address, abi: tokenAbi, method }))));
  const metadata = new Map<string, { decimals: number | null; name: string; symbol: string; retryable: boolean }>();
  let index = 0;
  for (const token of tokens) {
    const decimals = metadataRows[index++];
    const name = knownQuote(token) ? '' : readText(metadataRows[index++], 'name', 80);
    const symbol = knownQuote(token) ? '' : readText(metadataRows[index++], 'symbol', 30);
    metadata.set(token, { decimals: precision(decimals), name, symbol, retryable: decimals.retryable });
  }
  for (const pool of proven) {
    const token = metadata.get(pool.tokenAddress)!, quote = metadata.get(pool.quoteAddress)!;
    if (token.decimals === null || quote.decimals === null) {
      results.set(pool.poolAddress, token.retryable || quote.retryable ? 'retry' : 'rejected'); continue;
    }
    if (!isKolProfileToken({ address: pool.tokenAddress, name: token.name, symbol: token.symbol })) { results.set(pool.poolAddress, 'rejected'); continue; }
    results.set(pool.poolAddress, {
      poolAddress: pool.poolAddress, tokenAddress: pool.tokenAddress, quoteAddress: pool.quoteAddress, tokenIs0: pool.tokenIs0,
      name: token.name || token.symbol || `${pool.tokenAddress.slice(0, 6)}…${pool.tokenAddress.slice(-4)}`,
      symbol: token.symbol || token.name.slice(0, 30) || pool.tokenAddress.slice(-4),
      decimals0: pool.tokenIs0 ? token.decimals : quote.decimals, decimals1: pool.tokenIs0 ? quote.decimals : token.decimals,
    });
  }
  return results;
}

async function readQuoteAnchors(rpc: Rpc, block: MomentumBlock, addresses: readonly string[]) {
  const rows = await readState(rpc, block, addresses.flatMap(address => ['decimals', 'description', 'latestRoundData']
    .map(method => ({ address: TRUSTED_QUOTE_FEEDS[address].feed, abi: oracleMarketAbi, method }))));
  const anchors = new Map<string, Anchor>();
  const at = Date.parse(block.timestamp);
  addresses.forEach((address, index) => {
    const [decimals, description, data] = rows.slice(index * 3, index * 3 + 3), trusted = TRUSTED_QUOTE_FEEDS[address];
    const digits = precision(decimals);
    if (digits === null || description.value?.[0] !== trusted.description || !data.value) return;
    const round = BigInt(data.value.roundId), answered = BigInt(data.value.answeredInRound), answer = BigInt(data.value.answer);
    const updatedAt = Number(data.value.updatedAt) * 1_000;
    if (round <= 0n || answered < round || answer <= 0n || !safeUint(updatedAt) || !updatedAt || updatedAt > at ||
        at - updatedAt > trusted.maxAgeSeconds * 1_000) return;
    anchors.set(address, { block, at, round, updatedAt, priceUsd: MarketDecimal.raw(answer, digits).text() });
  });
  return anchors;
}

function coversQuote(anchor: Anchor, at: number, address: string) {
  return anchor.updatedAt <= at && at - anchor.updatedAt <= TRUSTED_QUOTE_FEEDS[address].maxAgeSeconds * 1_000;
}

function sameRound(start: Anchor, end: Anchor) {
  return start.round === end.round && start.updatedAt === end.updatedAt && start.priceUsd === end.priceUsd;
}

function nextRound(start: Anchor, end: Anchor) {
  return (start.round >> 64n) === (end.round >> 64n) && end.round === start.round + 1n && end.updatedAt > start.at;
}

function bracketedQuote(first: Anchor | undefined, end: Anchor | undefined, at: number) {
  if (!first || !end) return undefined;
  if (sameRound(first, end)) return end;
  // Adjacent proxy round IDs with the same phase establish that no round was
  // skipped. Equal-second blocks still need an exact canonical state read.
  if (!nextRound(first, end) || at === end.updatedAt) return undefined;
  return at < end.updatedAt ? first : end;
}

export function decodeNodeMomentumSwap(log: NodeMarketLog, block: MomentumBlock, pool: VerifiedMomentumPool, quoteUsd: string): MomentumSwap | null {
  const logIndex = quantity(log.logIndex), transactionIndex = quantity(log.transactionIndex);
  if (!validBlock(block) || log.removed || log.address !== pool.poolAddress || log.blockHash !== block.hash ||
      quantity(log.blockNumber) !== block.number || !hashPattern.test(log.transactionHash) || !safeUint(logIndex) || !safeUint(transactionIndex)) return null;
  const swap = decodeSwap({ log, block, logIndex, transactionIndex }, pool, quoteUsd);
  return swap === 'non_economic' ? null : swap;
}

function decodeSwap(row: LogRow, pool: VerifiedMomentumPool, quoteUsd: string | undefined): MomentumSwap | 'non_economic' | null {
  const { log, block, logIndex, transactionIndex } = row;
  try {
    if (!/^0x[a-f0-9]{448}$/.test(log.data) || log.topics.length !== 3 || log.topics.some(topic => !hashPattern.test(topic))) return null;
    const decoded = v3MarketAbi.parseLog(log);
    if (!decoded || decoded.name !== 'Swap') return null;
    const encoded = v3MarketAbi.encodeEventLog(decoded.fragment, decoded.args);
    if (encoded.data !== log.data || encoded.topics.some((topic, index) => topic !== log.topics[index])) return null;
    const amount0 = BigInt(decoded.args.amount0), amount1 = BigInt(decoded.args.amount1), sqrt = BigInt(decoded.args.sqrtPriceX96);
    if (sqrt < 4295128739n || sqrt >= 1461446703485210103287273052203988822378723970342n ||
        Math.abs(Number(decoded.args.tick)) > 887272) return null;
    // An authenticated V3 event can consume a dust input while output rounds
    // to zero. It is not a two-sided trade and provides no price evidence.
    if (!amount0 || !amount1) return 'non_economic';
    if ((amount0 > 0n) === (amount1 > 0n) || !quoteUsd) return null;
    const quote = pool.tokenIs0 ? amount1 : amount0, token = pool.tokenIs0 ? amount0 : amount1;
    const quoteDecimals = pool.tokenIs0 ? pool.decimals1 : pool.decimals0, tokenDecimals = pool.tokenIs0 ? pool.decimals0 : pool.decimals1;
    const usd = MarketDecimal.raw(abs(quote), quoteDecimals).mul(MarketDecimal.parse(quoteUsd));
    const volumeUsd = Number(usd.text());
    if (!Number.isFinite(volumeUsd) || volumeUsd <= 0 || volumeUsd > 1e18) return null;
    // A post-swap spot at the edge of the tick range may be many orders of
    // magnitude away from the actual fill. Use the executed ratio instead.
    const price = Number(usd.div(MarketDecimal.raw(abs(token), tokenDecimals)).text());
    const priceUsd = Number.isFinite(price) && price > 0 && price <= 1e18 ? price : null;
    return {
      poolAddress: pool.poolAddress, tokenAddress: pool.tokenAddress, quoteAddress: pool.quoteAddress, name: pool.name, symbol: pool.symbol,
      blockNumber: block.number, blockHash: block.hash, transactionHash: log.transactionHash, transactionIndex, logIndex,
      at: Date.parse(block.timestamp), side: quote > 0n ? 'buy' : 'sell', volumeUsd, priceUsd,
    };
  } catch { return null; }
}

function validateLogs(logs: unknown, headers: readonly MomentumBlock[], allowedPools: ReadonlySet<string> | null) {
  if (!Array.isArray(logs) || logs.length > NODE_MOMENTUM_MAX_LOGS) throw Error('momentum_scan_log_budget');
  const rows = new Map<string, LogRow>(), first = headers[0].number;
  for (const log of logs as NodeMarketLog[]) {
    if (!log || log.removed || !addressPattern.test(log.address) || allowedPools && !allowedPools.has(log.address) ||
        !Array.isArray(log.topics) || log.topics[0] !== NODE_MOMENTUM_V3_SWAP_TOPIC || !hashPattern.test(log.transactionHash)) {
      throw Error('momentum_scan_log_invalid');
    }
    const block = headers[quantity(log.blockNumber) - first], logIndex = quantity(log.logIndex), transactionIndex = quantity(log.transactionIndex);
    if (!block || block.hash !== log.blockHash || !safeUint(logIndex) || !safeUint(transactionIndex)) throw Error('momentum_scan_log_noncanonical');
    const key = `${log.blockHash}:${logIndex}`, previous = rows.get(key);
    if (previous) {
      const prior = previous.log;
      if (prior.address !== log.address || prior.transactionHash !== log.transactionHash || previous.transactionIndex !== transactionIndex ||
          prior.data !== log.data || prior.topics.join() !== log.topics.join()) throw Error('momentum_scan_log_conflict');
      continue;
    }
    rows.set(key, { log, block, logIndex, transactionIndex });
  }
  return [...rows.values()].sort((a, b) => a.block.number - b.block.number || a.logIndex - b.logIndex);
}

/** A truncated response never supplies coverage. Bisect only a verified size
 * refusal, preserve the exact filter and validate every half before combining.
 * Other failures leave the caller's block cursor untouched. */
async function readRangeLogs(rpc: Rpc, headers: readonly MomentumBlock[], allowedPools: ReadonlySet<string> | null, checkBudget: () => void) {
  const started = performance.now();
  const filter = { topics: [NODE_MOMENTUM_V3_SWAP_TOPIC], ...(allowedPools ? { address: [...allowedPools] } : {}) };
  const rows: LogRow[] = [];
  let logRequests = 0, logSplits = 0, resultCount = 0;

  async function readPage(first: number, last: number): Promise<void> {
    checkBudget();
    if (logRequests >= maxLogRequests || performance.now() - started >= logBudgetMs) throw Error('momentum_scan_log_request_budget');
    logRequests++;
    let logs: unknown;
    try {
      logs = await rpc<NodeMarketLog[]>('eth_getLogs', [{
        fromBlock: blockHex(headers[first].number), toBlock: blockHex(headers[last].number), ...filter,
      }]);
      if (Array.isArray(logs) && logs.length > NODE_MOMENTUM_MAX_LOGS) throw new NodeMomentumLogRangeLimitError();
    } catch (error) {
      if (!(error instanceof NodeMomentumLogRangeLimitError)) throw error;
      if (first === last) throw Error('momentum_scan_log_block_budget');
      logSplits++;
      const middle = Math.floor((first + last) / 2);
      await readPage(first, middle);
      await readPage(middle + 1, last);
      return;
    }
    checkBudget();
    if (!Array.isArray(logs)) throw Error('momentum_scan_log_invalid');
    resultCount += logs.length;
    if (resultCount > NODE_MOMENTUM_MAX_SCAN_LOGS) throw Error('momentum_scan_log_total_budget');
    if (performance.now() - started >= logBudgetMs) throw Error('momentum_scan_log_request_budget');
    rows.push(...validateLogs(logs, headers.slice(first, last + 1), allowedPools));
  }

  await readPage(0, headers.length - 1);
  return { rows, logRequests, logSplits };
}

export function createNodeMomentumIngest(rpc: Rpc, options: { identityLimit?: number; minimumObservations?: number } = {}) {
  const identityLimit = options.identityLimit ?? 8, minimumObservations = options.minimumObservations ?? 4;
  if (!safeUint(identityLimit) || identityLimit < 1 || identityLimit > 8 || !safeUint(minimumObservations) || minimumObservations < 1 ||
      minimumObservations > 32) throw Error('momentum_scan_settings_invalid');
  const verified = new Map<string, { pool: VerifiedMomentumPool; recheckAt: number; lastSwapAt: number; activity: number }>();
  const rejected = new Map<string, number>();
  const pending = new Map<string, PendingIdentity>();
  let priorQuotes = new Map<string, Anchor>();

  function scheduleCandidates(counts: ReadonlyMap<string, number>, to: MomentumBlock, fixed: boolean) {
    const now = Date.parse(to.timestamp);
    for (const [address, candidate] of pending) if (now - candidate.lastAt > pendingTtlMs) pending.delete(address);
    for (const [address, expiry] of rejected) if (expiry <= now) rejected.delete(address);
    for (const [address, count] of counts) {
      const existing = verified.get(address);
      if ((existing && (existing.recheckAt - identityRefreshAheadMs > now || count === 0)) || rejected.has(address)) continue;
      const previous = pending.get(address);
      pending.set(address, {
        firstBlock: previous?.firstBlock ?? to.number, lastBlock: to.number, lastAt: now, nextBlock: previous?.nextBlock ?? to.number,
        score: Math.min(1_000, (previous?.score ?? 0) + (previous?.lastBlock === to.number ? 0 : count)),
      });
    }
    const candidates = [...pending.entries()].filter(([address, row]) => counts.has(address) && row.nextBlock <= to.number &&
      (verified.has(address) || fixed || row.score >= minimumObservations));
    const refresh = candidates.filter(([address]) => verified.has(address)).map(([address]) => address)
      .sort((a, b) => verified.get(a)!.recheckAt - verified.get(b)!.recheckAt);
    const hot = [...candidates].sort((a, b) => (counts.get(b[0]) ?? 0) - (counts.get(a[0]) ?? 0) || b[1].score - a[1].score || a[1].firstBlock - b[1].firstBlock)
      .map(([address]) => address);
    const oldest = candidates.sort((a, b) => a[1].firstBlock - b[1].firstBlock || b[1].score - a[1].score).map(([address]) => address);
    const selected = [...new Set([...refresh.slice(0, Math.max(1, identityLimit - 2)), ...hot.slice(0, Math.max(1, identityLimit - 2)), ...oldest])]
      .slice(0, identityLimit);
    if (pending.size > 1_024) {
      const overflow = [...pending.entries()].sort((a, b) => a[1].score - b[1].score || a[1].lastAt - b[1].lastAt);
      for (const [address] of overflow.slice(0, pending.size - 1_024)) pending.delete(address);
    }
    return selected;
  }

  async function scan(headers: readonly MomentumBlock[], scanOptions: {
    discovery?: boolean; pools?: readonly string[]; shouldContinue?: () => boolean; parentHash?: string;
  } = {}): Promise<MomentumScanResult> {
    const checkBudget = () => { if (scanOptions.shouldContinue?.() === false) throw Error('momentum_scan_yielded'); };
    checkBudget();
    const from = headers[0], to = headers.at(-1);
    if (!from || !to || headers.length > NODE_MOMENTUM_MAX_RANGE || headers.some((block, index) => !validBlock(block) ||
        block.number !== from.number + index || index > 0 && Date.parse(block.timestamp) < Date.parse(headers[index - 1].timestamp))) {
      throw Error('momentum_scan_range_invalid');
    }
    const fixed = scanOptions.pools ? new Set(scanOptions.pools) : null;
    if (fixed && (!fixed.size || fixed.size > NODE_MOMENTUM_MAX_POOLS || [...fixed].some(pool => !addressPattern.test(pool))) ||
        !fixed && scanOptions.discovery === false) throw Error('momentum_scan_pools_invalid');
    const { rows, logRequests, logSplits } = await readRangeLogs(rpc, headers, fixed, checkBudget);
    const byPool = new Map<string, LogRow[]>([...(fixed ?? [])].map(address => [address, []]));
    for (const row of rows) {
      const bucket = byPool.get(row.log.address) ?? [];
      bucket.push(row);
      byPool.set(row.log.address, bucket);
    }
    checkBudget();
    const candidates = scheduleCandidates(new Map([...byPool].map(([address, swaps]) => [address, swaps.length])), to, !!fixed);
    const resolved = await authenticatePools(rpc, to, candidates, checkBudget);
    const endTime = Date.parse(to.timestamp);
    const uncovered = new Set<string>();
    let verifiedCount = 0;
    for (const [address, result] of resolved) {
      if (result === 'retry') {
        const row = pending.get(address);
        if (row) row.nextBlock = to.number + 32;
        continue;
      }
      pending.delete(address);
      if (result === 'rejected') {
        verified.delete(address);
        rejected.set(address, endTime + identityTtlMs);
        if (rejected.size > 1_024) rejected.delete(rejected.keys().next().value!);
      } else {
        verifiedCount++;
        const previous = verified.get(address);
        if (previous && (previous.pool.decimals0 !== result.decimals0 || previous.pool.decimals1 !== result.decimals1)) {
          uncovered.add(address);
        }
        verified.set(address, { pool: result, recheckAt: endTime + identityTtlMs, lastSwapAt: previous?.lastSwapAt ?? endTime, activity: previous?.activity ?? 0 });
      }
    }
    for (const [address, swaps] of byPool) {
      const entry = verified.get(address);
      if (entry && swaps.length) {
        const elapsed = endTime - entry.lastSwapAt;
        if (elapsed > 0 || entry.activity === 0) entry.activity = Math.min(10_000, entry.activity * Math.pow(0.5, elapsed / pendingTtlMs) + swaps.length);
        entry.lastSwapAt = endTime;
      }
    }
    if (verified.size > verifiedLimit) {
      const lowest = [...verified.entries()].map(([address, entry]) => ({
        address, weight: entry.activity * Math.pow(0.5, (endTime - entry.lastSwapAt) / pendingTtlMs),
      })).sort((a, b) => a.weight - b.weight);
      for (const { address } of lowest.slice(0, verified.size - verifiedLimit)) verified.delete(address);
    }
    const observed = [...byPool].flatMap(([address, swaps]) => {
      const entry = verified.get(address);
      if (!entry || !swaps.length) return [];
      if (entry.recheckAt <= endTime) { uncovered.add(address); return []; }
      return uncovered.has(address) ? [] : [{ pool: entry.pool, swaps }];
    });
    checkBudget();
    const quoteAddresses = [...new Set(observed.map(row => row.pool.quoteAddress))];
    const endAnchors = await readQuoteAnchors(rpc, to, quoteAddresses);
    const reusable = new Map<string, Anchor>();
    const fromTime = Date.parse(from.timestamp);
    const needsFirst = quoteAddresses.filter(address => {
      const prior = priorQuotes.get(address), end = endAnchors.get(address);
      if (from.number === to.number || !prior || !end || prior.block.number !== from.number - 1 || prior.block.hash !== scanOptions.parentHash
        || prior.at > fromTime || !coversQuote(prior, prior.at, address)) return true;
      const bracket = bracketedQuote(prior, end, fromTime);
      if (!bracket || !coversQuote(bracket, fromTime, address)) return true;
      reusable.set(address, prior);
      return false;
    });
    checkBudget();
    const firstAnchors = from.number === to.number ? endAnchors : await readQuoteAnchors(rpc, from, needsFirst);
    let quoteBlocksRead = Number(quoteAddresses.length > 0) + Number(from.number !== to.number && needsFirst.length > 0);
    const missingByBlock = new Map<number, Set<string>>();
    const rates = new Map<string, string>();
    for (const { pool, swaps } of observed) {
      const quote = pool.quoteAddress, end = endAnchors.get(quote), first = reusable.get(quote) ?? firstAnchors.get(quote);
      for (const { block } of swaps) {
        const at = Date.parse(block.timestamp), key = `${block.number}:${quote}`;
        if (rates.has(key)) continue;
        const exact = block.number === to.number ? end : block.number === from.number ? firstAnchors.get(quote) : undefined;
        const anchor = exact ?? bracketedQuote(first, end, at);
        if (anchor && coversQuote(anchor, at, quote)) rates.set(key, anchor.priceUsd);
        else if (from.number < block.number && block.number < to.number) {
          const entries = missingByBlock.get(block.number) ?? new Set<string>();
          entries.add(quote);
          missingByBlock.set(block.number, entries);
        }
      }
    }
    // Round-boundary work is bounded independently of swap count. Missing
    // historical state or a deferred block leaves its affected pool uncovered.
    for (const [number, addresses] of [...missingByBlock.entries()].slice(0, 4)) {
      checkBudget();
      const anchors = await readQuoteAnchors(rpc, headers[number - from.number], [...addresses]);
      quoteBlocksRead++;
      for (const [address, anchor] of anchors) rates.set(`${number}:${address}`, anchor.priceUsd);
    }
    priorQuotes = endAnchors;

    const observations: MomentumSwap[] = [];
    const coveredPools = [...verified.keys()].filter(address => !fixed || fixed.has(address));
    for (const { pool, swaps } of observed) {
      const priced = swaps.map(row => {
        const quote = rates.get(`${row.block.number}:${pool.quoteAddress}`);
        return decodeSwap(row, pool, quote);
      });
      if (priced.some(swap => swap === null)) uncovered.add(pool.poolAddress);
      else observations.push(...priced.filter((swap): swap is MomentumSwap => !!swap && swap !== 'non_economic'));
    }
    observations.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return {
      observations, coveredPools: coveredPools.filter(address => !uncovered.has(address)),
      stats: { logs: rows.length, emitters: byPool.size, decoded: observations.length, identitiesAttempted: candidates.length,
        identitiesVerified: verifiedCount, pendingIdentities: pending.size, coveredPools: coveredPools.length - uncovered.size,
        unpricedPools: uncovered.size, quoteBlocksRead, logRequests, logSplits },
    };
  }
  return { scan, clear() { verified.clear(); rejected.clear(); pending.clear(); priorQuotes.clear(); } };
}
