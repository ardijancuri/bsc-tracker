import WebSocket from 'ws';
import { ensureSchema, notifyUpdate, pool, setState } from './db.js';
import { flapLogoFromHtml } from './tokenLogo.js';
import { ensureSeeds } from './seeds.js';
import { hasRecognizedSwap, nativeSellProceeds, transferTopic, walletSwapFlows } from './swap.js';
import { calculateLeaderboard } from './pnl.js';

const rpcUrl = process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545';
const historicalRpcUrl = process.env.BSC_HISTORICAL_RPC_HTTP || 'https://bsc-dataseed.bnbchain.org';
const wsUrl = process.env.BSC_RPC_WS || 'ws://127.0.0.1:8546';
const bnbUsdFeed = '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';
const stableSymbols = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'USD1']);
const addressRe = /^0x[a-fA-F0-9]{40}$/;
const hashRe = /^0x[a-fA-F0-9]{64}$/;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const normalized = (value: unknown) => typeof value === 'string' && addressRe.test(value) ? value.toLowerCase() : null;
let rpcId = 0;

type RpcLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; removed?: boolean };
type RpcTx = { hash: string; from: string; to: string | null; value: string; blockNumber: string };
type RpcReceipt = { status: string; logs: RpcLog[]; blockHash: string };
type RpcBlock = { number: string; hash: string; parentHash: string; timestamp: string };

async function rpc<T>(method: string, params: unknown[], endpoint = rpcUrl): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result as T;
}
const hex = (value: number) => `0x${value.toString(16)}`;
const topicAddress = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const units = (value: bigint, decimals: number) => {
  const divisor = 10n ** BigInt(decimals);
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / divisor}${fraction ? `.${fraction}` : ''}`;
};

const bnbPrices = new Map<number, number>();
const oracleRounds = new Map<string, { price: number; updatedAt: number }>();
function parseOracleRound(raw: string): { id: bigint; price: number; updatedAt: number } | null {
  if (!/^0x[0-9a-fA-F]{320}$/.test(raw)) return null;
  const words = raw.slice(2).match(/.{64}/g)!;
  const price = Number(BigInt(`0x${words[1]}`)) / 1e8;
  const updatedAt = Number(BigInt(`0x${words[3]}`));
  return price > 0 && updatedAt > 0 ? { id: BigInt(`0x${words[0]}`), price, updatedAt } : null;
}
async function oracleRound(id: bigint) {
  const key = id.toString();
  const cached = oracleRounds.get(key);
  if (cached) return cached;
  const raw = await rpc<string>('eth_call', [{ to: bnbUsdFeed, data: `0x9a6fc8f5${id.toString(16).padStart(64, '0')}` }, 'latest']);
  const result = parseOracleRound(raw);
  if (!result) throw new Error(`Invalid Chainlink round ${key}`);
  const value = { price: result.price, updatedAt: result.updatedAt };
  oracleRounds.set(key, value);
  if (oracleRounds.size > 512) oracleRounds.delete(oracleRounds.keys().next().value!);
  return value;
}
async function historicalBnbPrice(time: number): Promise<{ price: number; updatedAt: number } | null> {
  const latest = parseOracleRound(await rpc<string>('eth_call', [{ to: bnbUsdFeed, data: '0xfeaf968c' }, 'latest']));
  if (!latest || time > Math.floor(Date.now() / 1000) + 60) return null;
  if (latest.updatedAt <= time) return time - latest.updatedAt <= 7200 ? latest : null;
  const phaseStart = (latest.id >> 64n) << 64n;
  let low = phaseStart + 1n;
  let high = latest.id;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const round = await oracleRound(middle);
    if (round.updatedAt <= time) low = middle;
    else high = middle - 1n;
  }
  const round = await oracleRound(low);
  return round.updatedAt <= time && time - round.updatedAt <= 7200 ? round : null;
}
async function bnbPrice(block: number | 'latest', blockTime?: number): Promise<{ price: number; updatedAt: number } | null> {
  const cached = typeof block === 'number' ? bnbPrices.get(block) : undefined;
  if (cached != null) return { price: cached, updatedAt: blockTime || 0 };
  try {
    let round;
    try {
      const raw = await rpc<string>('eth_call', [{ to: bnbUsdFeed, data: '0xfeaf968c' }, block === 'latest' ? 'latest' : hex(block)]);
      round = parseOracleRound(raw);
    } catch (error) {
      if (block === 'latest' || !blockTime || !/not supported|missing trie node|state.*unavailable|header not found|block not found/i.test(String(error))) throw error;
      round = await historicalBnbPrice(blockTime);
    }
    if (!round) return null;
    const { price, updatedAt } = round;
    const time = blockTime || Math.floor(Date.now() / 1000);
    if (!(price > 0) || updatedAt <= 0 || updatedAt > time + 60 || time - updatedAt > 7200) return null;
    if (typeof block === 'number') {
      bnbPrices.set(block, price);
      if (bnbPrices.size > 128) bnbPrices.delete(bnbPrices.keys().next().value!);
    }
    return { price, updatedAt };
  } catch (error) { console.warn('BNB price feed:', error); return null; }
}

type TokenMeta = { symbol: string | null; decimals: number };
const metadataCache = new Map<string, TokenMeta>();
function decodeSymbol(raw: string): string | null {
  try {
    const bytes = Buffer.from(raw.slice(2), 'hex');
    if (bytes.length >= 96 && bytes.readUInt32BE(28) === 32) {
      const length = bytes.readUInt32BE(60);
      if (length > 0 && length <= 64) return bytes.subarray(64, 64 + length).toString('utf8').replace(/\0/g, '') || null;
    }
    return bytes.subarray(0, 32).toString('utf8').replace(/\0/g, '').trim() || null;
  } catch { return null; }
}
async function tokenMeta(address: string): Promise<TokenMeta> {
  const cached = metadataCache.get(address);
  if (cached) return cached;
  const existing = await pool.query('SELECT symbol,decimals FROM tokens WHERE address=$1', [address]);
  if (existing.rows[0]?.decimals != null) {
    const result = { symbol: existing.rows[0].symbol as string | null, decimals: Number(existing.rows[0].decimals) };
    metadataCache.set(address, result);
    return result;
  }
  const [symbolResult, decimalsResult] = await Promise.allSettled([
    rpc<string>('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']),
    rpc<string>('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
  ]);
  const symbol = symbolResult.status === 'fulfilled' ? decodeSymbol(symbolResult.value) : null;
  let decimals = 18;
  if (decimalsResult.status === 'fulfilled') {
    try { decimals = Number(BigInt(decimalsResult.value)); } catch { /* Non-standard token. */ }
  }
  const result = { symbol, decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18 };
  metadataCache.set(address, result);
  await pool.query(`INSERT INTO tokens(address,symbol,decimals) VALUES($1,$2,$3) ON CONFLICT(address) DO UPDATE SET symbol=COALESCE(tokens.symbol,EXCLUDED.symbol),decimals=COALESCE(tokens.decimals,EXCLUDED.decimals)`, [address, result.symbol, result.decimals]);
  return result;
}

type Flow = { address: string; raw: bigint; amount: string; symbol: string | null };
async function persistNodeTrade(tx: RpcTx, receipt: RpcReceipt, block: RpcBlock, wallet: string) {
  if (receipt.status !== '0x1') return;
  const net = walletSwapFlows(wallet, BigInt(tx.value || '0x0'), receipt.logs);
  const entries = [...net.entries()];
  if (!entries.length) return;
  const nativeIn = BigInt(tx.value || '0x0') > 0n;
  const oracle = await bnbPrice(Number(BigInt(block.number)), Number(BigInt(block.timestamp)));
  const flows: Flow[] = await Promise.all(entries.map(async ([address, raw]) => {
    const meta = await tokenMeta(address);
    return { address, raw, amount: units(raw < 0n ? -raw : raw, meta.decimals), symbol: meta.symbol };
  }));
  const quote = (direction: bigint) => flows.find(flow => flow.raw * direction > 0n && (stableSymbols.has(flow.symbol?.toUpperCase() || '') || flow.symbol?.toUpperCase() === 'WBNB'));
  const directional = hasRecognizedSwap(receipt.logs) || nativeIn;
  for (const flow of flows) {
    const opposing = quote(flow.raw > 0n ? -1n : 1n) || flows.find(other => other.address !== flow.address && other.raw * flow.raw < 0n);
    const isQuote = stableSymbols.has(flow.symbol?.toUpperCase() || '') || flow.symbol?.toUpperCase() === 'WBNB';
    if (isQuote && flows.some(other => other.address !== flow.address && other.raw * flow.raw < 0n)) continue;
    const nativeSale = !opposing && flow.raw < 0n ? nativeSellProceeds(wallet, -flow.raw, receipt.logs,
      flows.filter(other => other.raw < 0n).length === 1 ? tx.to : null) : null;
    const quoteSymbol = opposing?.symbol || (nativeIn && flow.raw > 0n ? 'BNB' : nativeSale ? 'BNB' : null);
    const quoteAmount = opposing?.amount || (nativeIn && flow.raw > 0n ? units(BigInt(tx.value), 18) : nativeSale ? units(nativeSale, 18) : null);
    const amountUsd = quoteAmount && stableSymbols.has(quoteSymbol?.toUpperCase() || '') ? quoteAmount :
      quoteAmount && (quoteSymbol?.toUpperCase() === 'WBNB' || quoteSymbol?.toUpperCase() === 'BNB') && oracle ? String(Number(quoteAmount) * oracle.price) : null;
    const priceUsd = amountUsd && Number(flow.amount) > 0 ? String(Number(amountUsd) / Number(flow.amount)) : null;
    const side = directional ? (flow.raw > 0n ? 'buy' : 'sell') : 'unknown';
    await pool.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,quote_token_address,quote_symbol,quote_amount,amount_usd,price_usd,block_number,block_hash,timestamp,source,verification_attempted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_timestamp($14),'node',now())
      ON CONFLICT(tx_hash,wallet_address,token_address) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,side=CASE WHEN EXCLUDED.side='unknown' THEN trades.side ELSE EXCLUDED.side END,token_amount=EXCLUDED.token_amount,quote_token_address=COALESCE(trades.quote_token_address,EXCLUDED.quote_token_address),quote_symbol=COALESCE(trades.quote_symbol,EXCLUDED.quote_symbol),quote_amount=COALESCE(EXCLUDED.quote_amount,trades.quote_amount),amount_usd=COALESCE(EXCLUDED.amount_usd,trades.amount_usd),price_usd=COALESCE(EXCLUDED.price_usd,trades.price_usd),source=CASE WHEN trades.source='gmgn' THEN 'node+gmgn' ELSE trades.source END,verification_attempted_at=now()`,
      [`${tx.hash.toLowerCase()}:${wallet}:${flow.address}`, tx.hash.toLowerCase(), wallet, flow.address, side, flow.amount, opposing?.address || null, quoteSymbol, quoteAmount, amountUsd, priceUsd, Number(BigInt(block.number)), block.hash, Number(BigInt(block.timestamp))]);
    if (priceUsd && Number.isFinite(Number(priceUsd))) await pool.query(`UPDATE tokens SET price_usd=$2,price_source='onchain',metadata_updated_at=to_timestamp($3) WHERE address=$1 AND (price_source IS DISTINCT FROM 'onchain' OR metadata_updated_at IS NULL OR metadata_updated_at < to_timestamp($3))`, [flow.address, priceUsd, Number(BigInt(block.timestamp))]);
  }
  await pool.query('UPDATE kols SET last_seen_at=to_timestamp($2) WHERE address=$1', [wallet, Number(BigInt(block.timestamp))]);
}

async function rollbackIfReorg() {
  const last = await pool.query('SELECT block_number,block_hash FROM processed_blocks ORDER BY block_number DESC LIMIT 1');
  if (!last.rows.length) return;
  const height = Number(last.rows[0].block_number);
  const canonical = await rpc<RpcBlock | null>('eth_getBlockByNumber', [hex(height), false]);
  if (canonical?.hash.toLowerCase() === last.rows[0].block_hash.toLowerCase()) return;
  const rollbackFrom = Math.max(0, height - 12);
  await pool.query(`DELETE FROM trades WHERE block_number >= $1`, [rollbackFrom]);
  await pool.query('DELETE FROM processed_blocks WHERE block_number >= $1', [rollbackFrom]);
  console.warn(`Reorganization at ${height}; rescanning from ${rollbackFrom}`);
}

async function scanRange(from: number, to: number, head: number) {
  const walletRows = await pool.query('SELECT address FROM kols WHERE is_tracked');
  const wallets = new Set<string>(walletRows.rows.map(row => row.address));
  const topics = [...wallets].map(topicAddress);
  const matched = new Set<string>();
  for (let offset = 0; offset < topics.length; offset += 300) {
    const slice = topics.slice(offset, offset + 300);
    const filters = [
      [transferTopic, slice],
      [transferTopic, null, slice],
    ];
    for (const filter of filters) {
      const logs = await rpc<RpcLog[]>('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), topics: filter }]);
      for (const log of logs) if (!log.removed) matched.add(log.transactionHash.toLowerCase());
    }
  }
  const byBlock = new Map<number, { tx: RpcTx; receipt: RpcReceipt }[]>();
  for (const hash of matched) {
    const [tx, receipt] = await Promise.all([rpc<RpcTx>('eth_getTransactionByHash', [hash]), rpc<RpcReceipt>('eth_getTransactionReceipt', [hash])]);
    const wallet = normalized(tx.from);
    if (!wallet || !wallets.has(wallet) || !receipt || receipt.status !== '0x1') continue;
    const height = Number(BigInt(tx.blockNumber));
    const list = byBlock.get(height) || [];
    list.push({ tx, receipt });
    byBlock.set(height, list);
  }
  for (let height = from; height <= to; height++) {
    const block = await rpc<RpcBlock>('eth_getBlockByNumber', [hex(height), false]);
    if (!block) throw new Error(`Missing block ${height}`);
    const previous = await pool.query('SELECT block_hash FROM processed_blocks WHERE block_number=$1', [height - 1]);
    if (previous.rows.length && previous.rows[0].block_hash.toLowerCase() !== block.parentHash.toLowerCase()) throw new Error(`Parent hash mismatch at ${height}`);
    for (const entry of byBlock.get(height) || []) await persistNodeTrade(entry.tx, entry.receipt, block, normalized(entry.tx.from)!);
    await pool.query(`INSERT INTO processed_blocks(block_number,block_hash) VALUES($1,$2) ON CONFLICT(block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash,processed_at=now()`, [height, block.hash]);
    await setState('node', { blockNumber: height, headBlock: head, blockHash: block.hash });
  }
  await pool.query('DELETE FROM processed_blocks WHERE block_number < $1', [to - 128]);
  if (matched.size) await notifyUpdate();
}

async function nodeLoop() {
  let wake = () => {};
  let socket: WebSocket | null = null;
  const connect = () => {
    socket = new WebSocket(wsUrl);
    socket.on('open', () => socket?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] })));
    socket.on('message', () => wake());
    socket.on('error', error => console.error('WebSocket error:', error.message));
    socket.on('close', () => { socket = null; setTimeout(connect, 5000); });
  };
  connect();
  for (;;) {
    try {
      await rollbackIfReorg();
      const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])));
      const target = Math.max(0, head - 6);
      const latest = await pool.query('SELECT MAX(block_number) AS height FROM processed_blocks');
      const configured = Number(process.env.BSC_START_BLOCK);
      const start = latest.rows[0].height == null ? (Number.isInteger(configured) && configured > 0 ? configured : Math.max(0, target - 12)) : Number(latest.rows[0].height) + 1;
      if (start <= target) await scanRange(start, Math.min(target, start + 15), head);
      else await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 3000); });
    } catch (error) {
      console.error('Node worker:', error);
      await setState('node_error', { message: String(error), at: new Date().toISOString() });
      await sleep(5000);
    }
  }
}

async function verifyImportedTrade(hash: string, expectedWallets: string[]): Promise<'verified' | 'unmatched'> {
  const [tx, receipt] = await Promise.all([
    rpc<RpcTx | null>('eth_getTransactionByHash', [hash], historicalRpcUrl),
    rpc<RpcReceipt | null>('eth_getTransactionReceipt', [hash], historicalRpcUrl),
  ]);
  const wallet = tx && normalized(tx.from);
  if (!tx || !receipt || !wallet || !expectedWallets.includes(wallet) || receipt.status !== '0x1') return 'unmatched';
  const block = await rpc<RpcBlock | null>('eth_getBlockByNumber', [tx.blockNumber, false], historicalRpcUrl);
  if (!block || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return 'unmatched';
  await persistNodeTrade(tx, receipt, block, wallet);
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM trades
    WHERE tx_hash=$1 AND wallet_address=$2 AND source='node+gmgn' AND block_number IS NOT NULL`, [hash, wallet]);
  return result.rows[0].count > 0 ? 'verified' : 'unmatched';
}

async function historicalVerificationLoop() {
  for (;;) {
    try {
      const pending = await pool.query(`SELECT t.tx_hash AS hash,array_agg(DISTINCT t.wallet_address) AS wallets
        FROM trades t JOIN kols k ON k.address=t.wallet_address
        WHERE k.is_tracked AND (
          (t.source='gmgn' AND t.block_number IS NULL
            AND (t.verification_attempted_at IS NULL OR t.verification_attempted_at < now() - interval '1 day'))
          OR (t.source='node+gmgn' AND t.verification_attempted_at IS NULL)
        )
        GROUP BY t.tx_hash ORDER BY MAX(t.timestamp) DESC LIMIT 6`);
      if (!pending.rows.length) {
        await sleep(60_000);
        continue;
      }
      const outcomes = await Promise.all(pending.rows.map(async row => {
        let outcome: 'verified' | 'unmatched' | 'error';
        try { outcome = await verifyImportedTrade(row.hash, row.wallets); }
        catch (error) { console.warn(`Historical verification ${row.hash}:`, error); outcome = 'error'; }
        await pool.query(`UPDATE trades SET verification_attempted_at=now()
          WHERE tx_hash=$1 AND source IN ('gmgn','node+gmgn')`, [row.hash]);
        return outcome;
      }));
      const remaining = await pool.query(`SELECT COUNT(DISTINCT tx_hash)::int AS count FROM trades
        WHERE source IN ('gmgn','node+gmgn') AND verification_attempted_at IS NULL`);
      await setState('historical_verification', {
        at: new Date().toISOString(),
        remaining: remaining.rows[0].count,
        verified: outcomes.filter(outcome => outcome === 'verified').length,
        unmatched: outcomes.filter(outcome => outcome === 'unmatched').length,
        errors: outcomes.filter(outcome => outcome === 'error').length,
      });
      if (outcomes.includes('verified')) await notifyUpdate();
      await sleep(250);
    } catch (error) {
      console.error('Historical verification worker:', error);
      await sleep(10_000);
    }
  }
}

async function refreshXAvatarOne() {
  const result = await pool.query(`SELECT address,twitter FROM kols
    WHERE is_tracked AND twitter ~ '^[A-Za-z0-9_]{1,15}$'
      AND avatar_url IS NULL
      AND (avatar_checked_at IS NULL OR avatar_checked_at < now() - interval '7 days')
    ORDER BY avatar_checked_at ASC NULLS FIRST LIMIT 1`);
  const row = result.rows[0] as { address: string; twitter: string } | undefined;
  if (!row) return;
  try {
    const response = await fetch(`https://x.com/${encodeURIComponent(row.twitter)}`, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; bscan-avatar-fetch/1.0)' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const image = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)?.[1]?.replaceAll('&amp;', '&');
    if (!image || !/^https:\/\/pbs\.twimg\.com\/profile_images\//.test(image)) throw new Error('No public X profile image found');
    await pool.query('UPDATE kols SET avatar_url=$2,avatar_checked_at=now() WHERE address=$1 AND twitter=$3', [row.address, image, row.twitter]);
    await notifyUpdate();
  } catch (error) {
    const retrySoon = /HTTP (429|5\d\d)/.test(String(error));
    await pool.query(`UPDATE kols SET avatar_checked_at=CASE WHEN $2 THEN now()-interval '6 days 23 hours' ELSE now() END WHERE address=$1`, [row.address, retrySoon]);
    console.warn(`X avatar ${row.twitter}:`, error);
  }
}

async function avatarLoop() {
  for (;;) {
    try { await refreshXAvatarOne(); } catch (error) { console.warn('X avatar worker:', error); }
    await sleep(15_000);
  }
}

const validLogo = (value: unknown): value is string => typeof value === 'string' && /^https:\/\//i.test(value);
let pancakeLogos: { updatedAt: number; items: Map<string, string> } | null = null;
async function pancakeLogo(address: string): Promise<string | null> {
  if (!pancakeLogos || Date.now() - pancakeLogos.updatedAt > 86400_000) {
    try {
      const response = await fetch('https://tokens.pancakeswap.finance/pancakeswap-extended.json', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = await response.json() as { tokens?: { chainId: number; address: string; logoURI?: string }[] };
      const items = new Map<string, string>();
      for (const token of list.tokens || []) if (token.chainId === 56 && validLogo(token.logoURI)) items.set(token.address.toLowerCase(), token.logoURI);
      pancakeLogos = { updatedAt: Date.now(), items };
    } catch (error) { console.warn('PancakeSwap token logos:', error); }
  }
  return pancakeLogos?.items.get(address.toLowerCase()) || null;
}
async function lookupTokenLogo(address: string): Promise<string | null> {
  if (address.endsWith('4444') || address.endsWith('ffff')) {
    try {
      const response = await fetch(`https://four.meme/meme-api/v1/private/token/get?address=${address}`, { signal: AbortSignal.timeout(12000) });
      if (response.ok) {
        const result = await response.json() as { data?: { address?: string; image?: string } };
        if (result.data?.address?.toLowerCase() === address && validLogo(result.data.image)) return result.data.image;
      }
    } catch (error) { console.warn(`Four.meme logo ${address}:`, error); }
  }
  if (address.endsWith('7777') || address.endsWith('8888')) {
    try {
      const response = await fetch(`https://flap.sh/bnb/${address}`, { signal: AbortSignal.timeout(12000) });
      if (response.ok) {
        const html = await response.text();
        const image = flapLogoFromHtml(html, address);
        if (image) return image;
      }
    } catch (error) { console.warn(`Flap logo ${address}:`, error); }
  }
  const listed = await pancakeLogo(address);
  if (listed) return listed;
  const response = await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${address}`, { signal: AbortSignal.timeout(12000) });
  if (response.ok) {
    const pairs = await response.json() as { baseToken?: { address?: string }; info?: { imageUrl?: string } }[];
    const image = Array.isArray(pairs) ? pairs.find(pair => pair.baseToken?.address?.toLowerCase() === address && validLogo(pair.info?.imageUrl))?.info?.imageUrl : null;
    if (image) return image;
  }
  return null;
}

async function refreshTokenLogoOne() {
  const result = await pool.query(`SELECT t.address FROM tokens t WHERE
    (t.logo_url IS NULL OR btrim(t.logo_url)='' OR t.logo_url LIKE '%gmgn.ai%')
    AND (t.logo_checked_at IS NULL OR t.logo_checked_at < now() - CASE
      WHEN t.logo_url IS NULL OR btrim(t.logo_url)='' THEN interval '30 minutes'
      ELSE interval '7 days' END)
    ORDER BY CASE WHEN t.logo_url IS NULL OR btrim(t.logo_url)='' THEN 0 ELSE 1 END,
      (SELECT max(timestamp) FROM trades WHERE token_address=t.address) DESC NULLS LAST LIMIT 1`);
  const address = result.rows[0]?.address as string | undefined;
  if (!address) return;
  try {
    const logo = await lookupTokenLogo(address);
    await pool.query(`UPDATE tokens SET logo_url=COALESCE($2, NULLIF(logo_url,'')), logo_checked_at=now() WHERE address=$1`, [address, logo]);
    if (logo) await notifyUpdate();
  } catch (error) {
    await pool.query(`UPDATE tokens SET logo_checked_at=now()-interval '6 days 23 hours' WHERE address=$1`, [address]);
    console.warn(`Token logo ${address}:`, error);
  }
}

async function logoLoop() {
  for (;;) {
    try { await refreshTokenLogoOne(); } catch (error) { console.warn('Token logo worker:', error); }
    await sleep(4000);
  }
}

async function refreshTokenSupplyOne(): Promise<boolean> {
  const result = await pool.query(`SELECT t.address FROM tokens t
    WHERE t.price_source='onchain' AND t.price_usd > 0 AND t.decimals BETWEEN 0 AND 36
      AND (t.supply_checked_at IS NULL OR t.supply_checked_at < now() - interval '24 hours')
      AND EXISTS (SELECT 1 FROM trades x JOIN kols k ON k.address=x.wallet_address
        WHERE x.token_address=t.address AND k.is_tracked AND x.block_number IS NOT NULL)
    ORDER BY t.metadata_updated_at DESC NULLS LAST LIMIT 1`);
  const address = result.rows[0]?.address as string | undefined;
  if (!address) return false;
  try {
    const raw = await rpc<string>('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']);
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('Invalid totalSupply response');
    const supply = BigInt(raw);
    await pool.query('UPDATE tokens SET total_supply_raw=$2,supply_checked_at=now() WHERE address=$1', [address, supply > 0n ? supply.toString() : null]);
  } catch (error) {
    await pool.query(`UPDATE tokens SET supply_checked_at=now()-interval '23 hours' WHERE address=$1`, [address]);
    console.warn(`Token supply ${address}:`, error);
  }
  return true;
}

async function supplyLoop() {
  for (;;) {
    let checked = false;
    try { checked = await refreshTokenSupplyOne(); } catch (error) { console.warn('Token supply worker:', error); }
    await sleep(checked ? 250 : 60_000);
  }
}

async function refreshMarketCaps(): Promise<boolean> {
  const result = await pool.query(`SELECT t.address FROM tokens t
    WHERE (t.market_cap_checked_at IS NULL OR t.market_cap_checked_at < now() - interval '30 minutes')
      AND EXISTS (SELECT 1 FROM trades x JOIN kols k ON k.address=x.wallet_address
        WHERE x.token_address=t.address AND k.is_tracked AND x.block_number IS NOT NULL)
    ORDER BY (SELECT MAX(timestamp) FROM trades WHERE token_address=t.address) DESC NULLS LAST LIMIT 30`);
  const addresses = result.rows.map(row => row.address as string);
  if (!addresses.length) return false;
  try {
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${addresses.join(',')}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pairs = await response.json() as { baseToken?: { address?: string }; marketCap?: number | null; liquidity?: { usd?: number } }[];
    if (!Array.isArray(pairs)) throw new Error('Invalid token pairs response');
    const wanted = new Set(addresses);
    const caps = new Map<string, { cap: number; liquidity: number }>();
    for (const pair of pairs) {
      const address = pair.baseToken?.address?.toLowerCase();
      const cap = Number(pair.marketCap);
      const liquidity = Number(pair.liquidity?.usd || 0);
      if (!address || !wanted.has(address) || !Number.isFinite(cap) || cap <= 0) continue;
      if (!caps.has(address) || liquidity > caps.get(address)!.liquidity) caps.set(address, { cap, liquidity });
    }
    for (const address of addresses) {
      await pool.query('UPDATE tokens SET market_cap_usd=$2,market_cap_checked_at=now() WHERE address=$1', [address, caps.get(address)?.cap ?? null]);
    }
    await notifyUpdate();
  } catch (error) {
    await pool.query(`UPDATE tokens SET market_cap_checked_at=now()-interval '25 minutes' WHERE address=ANY($1::text[])`, [addresses]);
    console.warn('Market cap worker:', error);
  }
  return true;
}

async function marketCapLoop() {
  for (;;) {
    let checked = false;
    try { checked = await refreshMarketCaps(); } catch (error) { console.warn('Market cap worker:', error); }
    await sleep(checked ? 1000 : 60_000);
  }
}

async function repairSellValueOne() {
  const result = await pool.query(`SELECT id,tx_hash FROM trades WHERE side='sell' AND amount_usd IS NULL
    AND source IN ('node','node+gmgn') AND block_number IS NOT NULL
    AND timestamp >= now() - interval '30 days'
    AND (value_checked_at IS NULL OR value_checked_at < now() - interval '30 days')
    ORDER BY timestamp DESC LIMIT 1`);
  const row = result.rows[0] as { id: string; tx_hash: string } | undefined;
  if (!row) return;
  let success = false;
  try {
    const [tx, receipt] = await Promise.all([
      rpc<RpcTx | null>('eth_getTransactionByHash', [row.tx_hash]),
      rpc<RpcReceipt | null>('eth_getTransactionReceipt', [row.tx_hash]),
    ]);
    if (tx && receipt) {
      const wallet = normalized(tx.from);
      if (wallet) {
        const block = await rpc<RpcBlock>('eth_getBlockByNumber', [tx.blockNumber, false]);
        if (block) {
          await persistNodeTrade(tx, receipt, block, wallet);
          success = true;
        }
      }
    }
  } finally {
    await pool.query(`UPDATE trades SET value_checked_at=CASE WHEN $2 THEN now() ELSE now()-interval '29 days' END WHERE id=$1`, [row.id, success]);
    if (success) await notifyUpdate();
  }
}

async function sellValueLoop() {
  for (;;) {
    try { await repairSellValueOne(); } catch (error) { console.warn('Sell value worker:', error); }
    await sleep(1500);
  }
}

async function priceLoop() {
  for (;;) {
    try {
      const current = await bnbPrice('latest');
      if (current) {
        await setState('bnb_price', { priceUsd: current.price, oracleUpdatedAt: new Date(current.updatedAt * 1000).toISOString() });
        await notifyUpdate();
      }
    } catch (error) { console.warn('Price worker:', error); }
    await sleep(30_000);
  }
}

async function leaderboardLoop() {
  for (;;) {
    try {
      const [roster, tradeRows] = await Promise.all([
        pool.query('SELECT address FROM kols WHERE is_tracked ORDER BY address'),
        pool.query(`SELECT t.wallet_address AS "walletAddress",t.token_address AS "tokenAddress",t.side,t.token_amount AS "tokenAmount",t.amount_usd AS "amountUsd",t.timestamp
          FROM trades t JOIN kols k ON k.address=t.wallet_address
          WHERE k.is_tracked AND t.block_number IS NOT NULL AND t.side IN ('buy','sell')
          ORDER BY t.timestamp ASC,t.id ASC`),
      ]);
      const stats = calculateLeaderboard(tradeRows.rows, roster.rows.map(row => row.address as string));
      if (stats.length) {
        await pool.query(`INSERT INTO leaderboard_snapshots(wallet_address,period,realized_profit_usd,buy_count,sell_count,win_rate,updated_at)
          SELECT "walletAddress",period,"realizedProfitUsd","buyCount","sellCount","winRate",now()
          FROM jsonb_to_recordset($1::jsonb) AS x("walletAddress" text,period text,"realizedProfitUsd" numeric,"buyCount" integer,"sellCount" integer,"winRate" numeric)
          ON CONFLICT(wallet_address,period) DO UPDATE SET realized_profit_usd=EXCLUDED.realized_profit_usd,
          unrealized_profit_usd=NULL,buy_count=EXCLUDED.buy_count,sell_count=EXCLUDED.sell_count,
          win_rate=EXCLUDED.win_rate,updated_at=now()`, [JSON.stringify(stats)]);
        await setState('leaderboard', { at: new Date().toISOString(), source: 'onchain', wallets: roster.rows.length });
        await notifyUpdate();
      }
    } catch (error) { console.error('Leaderboard worker:', error); }
    await sleep(120_000);
  }
}

async function verifyTransactionHash(hash: string) {
  if (!hashRe.test(hash)) throw new Error('BSC_VERIFY_TX_HASH must be a transaction hash');
  const [tx, receipt] = await Promise.all([rpc<RpcTx | null>('eth_getTransactionByHash', [hash]), rpc<RpcReceipt | null>('eth_getTransactionReceipt', [hash])]);
  if (!tx || !receipt) throw new Error(`Transaction not available from node: ${hash}`);
  const wallet = normalized(tx.from);
  if (!wallet) throw new Error(`Invalid transaction sender: ${tx.from}`);
  const tracked = await pool.query('SELECT 1 FROM kols WHERE address=$1 AND is_tracked', [wallet]);
  if (!tracked.rows.length) throw new Error(`Initiating wallet is not in the tracked roster: ${tx.from}`);
  const block = await rpc<RpcBlock>('eth_getBlockByNumber', [tx.blockNumber, false]);
  const before = await pool.query('SELECT source,token_amount FROM trades WHERE tx_hash=$1 AND wallet_address=$2', [hash.toLowerCase(), wallet]);
  await persistNodeTrade(tx, receipt, block, wallet);
  const after = await pool.query('SELECT source,token_amount,side FROM trades WHERE tx_hash=$1 AND wallet_address=$2', [hash.toLowerCase(), wallet]);
  await notifyUpdate();
  console.log(JSON.stringify({ hash, wallet, block: Number(BigInt(tx.blockNumber)), before: before.rows, after: after.rows }));
}

await ensureSchema();
await ensureSeeds();
if (process.env.BSC_VERIFY_TX_HASH) {
  await verifyTransactionHash(process.env.BSC_VERIFY_TX_HASH);
  await pool.end();
} else {
  await Promise.all([nodeLoop(), historicalVerificationLoop(), priceLoop(), leaderboardLoop(), avatarLoop(), logoLoop(), sellValueLoop(), supplyLoop(), marketCapLoop()]);
}
