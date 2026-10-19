import type { Pool, PoolClient } from 'pg';
import {createHash,randomUUID}from'node:crypto';
import {setImmediate as yieldEventLoop}from'node:timers/promises';
import { ZeroAddress } from 'ethers';
import type { Rpc } from './rpc.js';
import { blockHex, chainRpc,rpcBatch } from './rpc.js';
import { pool } from './db.js';
import { FLAP_PORTAL, FOUR_HELPER, FOUR_MANAGERS, PCS_V2_FACTORY, PCS_V3_FACTORY, WBNB, flapInterface, fourInterface, parseLaunchLog } from './launchpad.js';
import type { NodeMarketBar, NodeMarketChart, NodeMarketImport, NodeMarketProvenance, NodeMarketQuote,NodeMarketReplaySamples } from '../shared/nodeMarket.js';
import { MarketDecimal, positiveDecimal, ratioPrice, sqrtPrice } from './nodeMarketMath.js';
import {selectNodeQuoteConversion,type NodeQuoteConversionRoute} from './nodeMarketConversion.js';
import {NodeMarketWorkCache}from'./nodeMarketWorkCache.js';
import {isKolProfileToken,kolProfileTokenSql} from './kolProfileToken.js';
import {enqueueNodeEvidenceMetadataCheckpoints} from './nodeEvidenceMetadata.js';
import { authenticatedPoolKey, binPrice, decodeNodeMarketLog, erc20MarketAbi, INFINITY_BIN, INFINITY_CL, infinityBinMarketAbi, infinityMarketAbi,
  nodeMarketDecoderVersion,oracleMarketAbi, poolMarketAbi, protocolMarketTopics,indexNodeControllerLogs, TRUSTED_QUOTE_FEEDS, type NodeMarketIdentity, type NodeMarketLog } from './nodeMarketProtocols.js';
export { ensureNodeMarketSchema } from './nodeMarketSchema.js';
export type NodeMarketDatabase = Pick<Pool, 'query' | 'connect'>;
type DB = Pick<Pool | PoolClient, 'query'>;
export interface NodeMarketBlock { blockNumber: number; blockHash: string; timestamp: string; parentHash?: string }
const address = (value: string) => { if (!/^0x[0-9a-f]{40}$/i.test(value)) throw new Error('invalid_market_address'); return value.toLowerCase(); };
const hash = (value: string) => { if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('invalid_market_hash'); return value.toLowerCase(); };
const iso = (value: string) => { const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error('invalid_market_timestamp'); return new Date(time).toISOString(); };
const dateText = (value: string | Date) => iso(value instanceof Date ? value.toISOString() : value);
const MAX_RANGE = 500, MAX_PRICE_AGE = 120_000;
const provenance = (items: { source: string }[]): NodeMarketProvenance => {
  const sources = new Set(items.map(item => item.source)); return sources.size > 1 ? 'mixed' : sources.has('imported') ? 'imported' : 'node';
};
const identity = (row: any): NodeMarketIdentity => ({ id: row.id, token: row.token_address, quote: row.quote_address, protocol: row.protocol,
  contract: row.contract_address, poolId: row.pool_id, token0: row.token0, token1: row.token1,
  decimals0: row.decimals0, decimals1: row.decimals1, authentication: row.authentication });
const missingQuote = (token: string, reason: NodeMarketQuote['reason']): NodeMarketQuote => ({ tokenAddress: token, priceUsd: null,
  marketCapUsd: null, supply: null, timestamp: null, blockNumber: null, blockHash: null, source: 'node', marketId: null,
  stale: false, supplyEstimated: false, reason });

/** Bounded database reads only; callers never initiate RPC or external requests. */
export async function readNodeMarketQuote(db: DB, tokenAddress: string, options: { now?: number; maxAgeMs?: number; timestamp?: string; blockNumber?: string } = {}): Promise<NodeMarketQuote> {
  const token = address(tokenAddress), now = options.now ?? Date.now(), at = options.timestamp ? iso(options.timestamp) : new Date(now).toISOString();
  const result = await db.query(`SELECT o.price_usd::text,o.timestamp,o.block_number::text,o.block_hash,o.source,o.market_id,
      o.supply::text,o.supply_estimated, m.status
    FROM node_market_observations o LEFT JOIN node_markets m ON m.id=o.market_id
    WHERE o.token_address=$1 AND o.timestamp<=$2::timestamptz
      AND ($3::bigint IS NULL OR o.block_number IS NULL OR o.block_number<=$3::bigint)
    ORDER BY o.timestamp DESC, CASE WHEN o.source='node' THEN 0 ELSE 1 END,
      COALESCE(o.block_number,0) DESC,CASE WHEN o.kind='state' AND o.tx_hash IS NULL THEN 1 ELSE 0 END DESC,
      COALESCE(o.transaction_index,-1) DESC,CASE WHEN o.kind='state' THEN 1 ELSE 0 END DESC,COALESCE(o.log_index,-1) DESC LIMIT 1`,
  [token, at, options.blockNumber ?? null]);
  const row = result.rows[0];
  if (!row) {
    // Trusted quote assets may be needed to value fees before any watched
    // token market is discovered. This is still persisted feed evidence.
    const config=TRUSTED_QUOTE_FEEDS[token];
    const feed = config ? (await db.query(`SELECT price_usd::text,timestamp,block_number::text,block_hash
      FROM node_market_feed_evidence WHERE quote_address=$1 AND timestamp<=$2::timestamptz
      AND ($3::bigint IS NULL OR block_number<=$3::bigint) AND feed_address=$4 AND feed_description=$5 ORDER BY block_number DESC LIMIT 1`, [token, at, options.blockNumber ?? null,config.feed,config.description])).rows[0] : null;
    if (feed) {
      const stale = Date.parse(at) - Date.parse(dateText(feed.timestamp)) > (options.maxAgeMs ?? MAX_PRICE_AGE);
      return { ...missingQuote(token, stale ? 'stale_quote' : null), priceUsd: feed.price_usd, timestamp: dateText(feed.timestamp),
        blockNumber: feed.block_number, blockHash: feed.block_hash, stale };
    }
    const conversion=(await db.query(`SELECT price_usd::text,timestamp,block_number::text,block_hash,pool_address FROM node_market_quote_evidence
      WHERE quote_address=$1 AND schema_version=1 AND timestamp<=$2::timestamptz AND ($3::bigint IS NULL OR block_number<=$3)
      ORDER BY block_number DESC LIMIT 1`,[token,at,options.blockNumber??null])).rows[0];
    if(conversion) {
      const timestamp=dateText(conversion.timestamp),stale=Date.parse(at)-Date.parse(timestamp)>(options.maxAgeMs??MAX_PRICE_AGE);
      return {...missingQuote(token,stale?'stale_quote':null),priceUsd:conversion.price_usd,timestamp,blockNumber:conversion.block_number,
        blockHash:conversion.block_hash,marketId:conversion.pool_address,stale};
    }
    const market = (await db.query('SELECT status FROM node_markets WHERE token_address=$1 LIMIT 1', [token])).rows[0];
    return missingQuote(token, market?.status === 'unsupported' ? 'unsupported_decoder' : market ? 'missing_quote' : 'no_market');
  }
  const timestamp = dateText(row.timestamp), stale = Date.parse(at) - Date.parse(timestamp) > (options.maxAgeMs ?? MAX_PRICE_AGE);
  return { tokenAddress: token, priceUsd: row.price_usd, marketCapUsd: row.supply ? MarketDecimal.parse(row.price_usd).mul(MarketDecimal.parse(row.supply)).text() : null,
    supply: row.supply, timestamp, blockNumber: row.block_number, blockHash: row.block_hash, source: row.source, marketId: row.market_id,
    stale, supplyEstimated: row.supply_estimated, reason: stale ? 'stale_quote' : null };
}

export function aggregateNodeMarketBars(rows: NodeMarketBar[], intervalSeconds: number): NodeMarketBar[] {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds % 60 !== 0) throw new Error('invalid_chart_interval');
  const bars = new Map<number, NodeMarketBar>();
  for (const input of [...rows].sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
    // Preserve a genuine imported interval when placing its OHLC in a larger
    // bucket. A lone 12:28 minute must not gain a 12:25 opening observation.
    const row=input.source==='imported'?{...input,firstObservationAt:input.firstObservationAt??input.timestamp,
      lastObservationAt:input.lastObservationAt??new Date(Date.parse(input.timestamp)+input.intervalSeconds*1000).toISOString()}:input;
    const bucket = Math.floor(Date.parse(row.timestamp) / (intervalSeconds * 1000)) * intervalSeconds * 1000;
    const current = bars.get(bucket);
    if (!current) { bars.set(bucket, { ...row, timestamp: new Date(bucket).toISOString(), intervalSeconds }); continue; }
    if (MarketDecimal.parse(row.high).compare(MarketDecimal.parse(current.high)) > 0) current.high = row.high;
    if (MarketDecimal.parse(row.low).compare(MarketDecimal.parse(current.low)) < 0) current.low = row.low;
    current.close = row.close;
    if(row.firstObservationAt&&(!current.firstObservationAt||Date.parse(row.firstObservationAt)<Date.parse(current.firstObservationAt)))current.firstObservationAt=row.firstObservationAt;
    if(row.lastObservationAt&&(!current.lastObservationAt||Date.parse(row.lastObservationAt)>Date.parse(current.lastObservationAt)))current.lastObservationAt=row.lastObservationAt;
    current.volumeUsd = current.volumeUsd != null && row.volumeUsd != null ? MarketDecimal.parse(current.volumeUsd).add(MarketDecimal.parse(row.volumeUsd)).text() : null;
    current.source = current.source === row.source ? current.source : 'mixed';
    current.supplyEstimated ||= row.supplyEstimated || current.supply !== row.supply;
    current.supply = row.supply;
  }
  return [...bars.values()];
}
export function nodeMarketCoverageComplete(from: string, to: string, ranges: { from: string; to: string }[]) {
  let covered = Date.parse(from); const end = Date.parse(to);
  for (const range of [...ranges].sort((a,b) => Date.parse(a.from) - Date.parse(b.from))) {
    const a = Date.parse(range.from), b = Date.parse(range.to);
    // Adjacent block timestamps can differ by up to 3 seconds on older BSC.
    if (a > covered + 3000) return false;
    covered = Math.max(covered, b); if (covered >= end) return true;
  }
  return covered >= end;
}
/** Replay lines may disclose sparse genuine state samples while candle decoding
 * continues. No volume, OHLC, coverage extension or price is synthesized here. */
export async function readNodeMarketReplaySamples(db:DB,tokenAddress:string,options:{from:string;to:string;limit?:number}):Promise<NodeMarketReplaySamples>{
  const token=address(tokenAddress),from=iso(options.from),to=iso(options.to),limit=Math.max(2,Math.min(5000,options.limit??2000));
  if(Date.parse(to)<Date.parse(from))throw new Error('invalid_chart_window');
  const [prices,ranges]=await Promise.all([
    db.query(`SELECT DISTINCT ON(o.timestamp) o.timestamp,o.price_usd::text,o.supply::text,o.supply_estimated,
      o.block_number::text,o.block_hash,o.market_id,o.kind FROM node_market_observations o JOIN node_markets m ON m.id=o.market_id
      WHERE o.token_address=$1 AND o.source='node' AND o.kind IN ('swap','state') AND o.block_number IS NOT NULL
        AND o.block_hash IS NOT NULL AND o.timestamp BETWEEN $2::timestamptz-interval '180 seconds' AND $3::timestamptz
      ORDER BY o.timestamp,o.block_number DESC,CASE WHEN o.kind='state' THEN 1 ELSE 0 END DESC,
        o.transaction_index DESC NULLS LAST,o.log_index DESC NULLS LAST,o.market_id LIMIT $4`,[token,from,to,limit+1]),
    db.query(`SELECT r.from_at,r.to_at,'node' AS source FROM node_market_ranges r JOIN node_markets m ON m.id=r.market_id
      WHERE m.token_address=$1 AND r.complete AND r.to_at>=$2::timestamptz AND r.from_at<=$3::timestamptz
      UNION ALL SELECT from_at,to_at,'imported' AS source FROM node_market_import_ranges WHERE token_address=$1
        AND complete AND to_at>=$2::timestamptz AND from_at<=$3::timestamptz ORDER BY from_at,to_at`,[token,from,to]),
  ]);
  return {tokenAddress:token,from,to,truncated:prices.rows.length>limit,observations:prices.rows.slice(0,limit).map(row=>({
    timestamp:dateText(row.timestamp),priceUsd:row.price_usd,supply:row.supply,supplyEstimated:row.supply_estimated,
    blockNumber:row.block_number,blockHash:row.block_hash,marketId:row.market_id,kind:row.kind})),
    coverage:ranges.rows.map(row=>({from:dateText(row.from_at),to:dateText(row.to_at),source:row.source as NodeMarketProvenance}))};
}
export async function readNodeMarketChart(db: DB, tokenAddress: string, options: { from: string; to: string; intervalSeconds?: number; limit?: number }): Promise<NodeMarketChart> {
  const token = address(tokenAddress), from = iso(options.from), to = iso(options.to), span = Date.parse(to) - Date.parse(from);
  if (span < 0) throw new Error('invalid_chart_window');
  const limit = Math.min(5000, Math.max(2, options.limit ?? 1800));
  const intervals = [60, 300, 900, 3600, 14400, 86400];
  const intervalSeconds = options.intervalSeconds ?? intervals.find(value => span / 1000 / value <= limit) ?? 86400;
  if (!intervals.includes(intervalSeconds)) throw new Error('invalid_chart_interval');
  // One-minute candles contain swaps from every participant. State refreshes
  // are intentionally absent: a quote observation never invents candle volume.
  const results = await Promise.all([
    db.query(`WITH chosen AS (
      SELECT DISTINCT ON(c.minute) c.* FROM (
        SELECT * FROM node_market_candles WHERE token_address=$1 AND minute>date_trunc('minute',$2::timestamptz) AND minute<date_trunc('minute',$3::timestamptz)
        UNION ALL
        SELECT token_address,market_id,date_trunc('minute',timestamp) AS minute,
          (array_agg(price_usd ORDER BY timestamp,block_number,transaction_index,log_index))[1] AS open,max(price_usd) AS high,min(price_usd) AS low,
          (array_agg(price_usd ORDER BY timestamp DESC,block_number DESC,transaction_index DESC,log_index DESC))[1] AS close,
          sum(COALESCE(volume_usd,0)) AS volume_usd,count(*)::integer AS observations,min(timestamp) AS first_observation_at,max(timestamp) AS last_observation_at
          FROM node_market_observations WHERE token_address=$1 AND kind='swap' AND timestamp BETWEEN $2::timestamptz AND $3::timestamptz
            AND (timestamp<date_trunc('minute',$2::timestamptz)+interval '1 minute' OR timestamp>=date_trunc('minute',$3::timestamptz))
          GROUP BY token_address,market_id,date_trunc('minute',timestamp)
      ) c JOIN node_markets m ON m.id=c.market_id
        ORDER BY c.minute,c.observations DESC,c.market_id
      ), bucketed AS (SELECT *,to_timestamp(floor(extract(epoch FROM minute)/$4)*$4) AS bucket FROM chosen)
      SELECT bucket AS minute,(array_agg(open ORDER BY minute))[1]::text AS open,max(high)::text AS high,min(low)::text AS low,
        (array_agg(close ORDER BY minute DESC))[1]::text AS close,sum(volume_usd)::text AS volume_usd,
        min(first_observation_at) AS first_observation_at,max(last_observation_at) AS last_observation_at
        FROM bucketed GROUP BY bucket ORDER BY bucket LIMIT $5`, [token, from, to,intervalSeconds,limit]),
    db.query(`SELECT timestamp,open::text,high::text,low::text,COALESCE(close,price_usd)::text AS close,price_usd::text,volume_usd::text,supply::text,interval_seconds
      FROM node_market_observations WHERE token_address=$1 AND kind='imported' AND timestamp>=$2::timestamptz-$4*interval '1 second' AND timestamp<=$3::timestamptz
      AND timestamp+interval_seconds*interval '1 second'>=$2::timestamptz
      AND interval_seconds<=$4 ORDER BY timestamp,interval_seconds`, [token, from, to, intervalSeconds]),
    db.query(`SELECT r.from_at,r.to_at,'node' AS source FROM node_market_ranges r JOIN node_markets m ON m.id=r.market_id
      WHERE m.token_address=$1 AND r.complete AND r.to_at>=$2::timestamptz AND r.from_at<=$3::timestamptz
      UNION ALL SELECT from_at,to_at,'imported' FROM node_market_import_ranges WHERE token_address=$1 AND complete
        AND to_at>=$2::timestamptz AND from_at<=$3::timestamptz`, [token, from, to]),
    db.query(`SELECT m.status,EXISTS(SELECT 1 FROM node_market_raw_logs l WHERE l.market_id=m.id
      AND l.timestamp BETWEEN $2::timestamptz AND $3::timestamptz AND l.decode_status IN ('pending','missing_quote','invalid'))
      OR EXISTS(SELECT 1 FROM node_market_observations p WHERE p.market_id=m.id AND p.kind='swap' AND p.candles_pending
        AND p.timestamp BETWEEN $2::timestamptz AND $3::timestamptz) AS pending
      FROM node_markets m WHERE m.token_address=$1`, [token,from,to]),
  ]);
  const coverage = results[2].rows.map(row => ({ from: dateText(row.from_at), to: dateText(row.to_at), source: row.source as NodeMarketProvenance }));
  const nodePending=results[3].rows.some(row=>row.pending);
  // A complete, independently imported market series remains usable while raw
  // node evidence is being decoded. Partial node minutes must not overwrite
  // those complete candles or hold an already covered historical replay open.
  const importedFallback=nodePending&&results[1].rows.length>0&&nodeMarketCoverageComplete(from,to,coverage.filter(row=>row.source==='imported'));
  const minutes = new Map<number, NodeMarketBar>();
  for (const row of results[1].rows) {
    const timestamp = dateText(row.timestamp), key = Date.parse(timestamp);
    if (!minutes.has(key)) minutes.set(key, { timestamp, open: row.open ?? row.price_usd, high: row.high ?? row.price_usd,
      low: row.low ?? row.price_usd, close: row.close, volumeUsd: row.volume_usd, source: 'imported',
      intervalSeconds: row.interval_seconds || 60, supply: row.supply, supplyEstimated: row.supply == null });
  }
  for (const row of results[0].rows) {
    if(importedFallback)continue;
    const timestamp = dateText(row.minute), key = Date.parse(timestamp);
    // Deterministic highest-activity market per minute, rather than adding
    // duplicated arbitrage volume across all pools for the same token.
    if (minutes.get(key)?.source === 'node') continue;
    minutes.set(key, { timestamp, open: String(row.open), high: String(row.high), low: String(row.low), close: String(row.close),
      ...(row.first_observation_at?{firstObservationAt:dateText(row.first_observation_at)}:{}),...(row.last_observation_at?{lastObservationAt:dateText(row.last_observation_at)}:{}),
      volumeUsd: String(row.volume_usd), intervalSeconds, source: 'node', supply: null, supplyEstimated: true });
  }
  const bars = aggregateNodeMarketBars([...minutes.values()], intervalSeconds).slice(-limit);
  const complete = nodeMarketCoverageComplete(from, to, coverage) && bars.length > 0 && (!nodePending||importedFallback);
  const sparse = bars.some((bar,index) => index > 0 && Date.parse(bar.timestamp) - Date.parse(bars[index - 1].timestamp) > intervalSeconds * 1000);
  return { tokenAddress: token, from, to, intervalSeconds, bars, source: provenance(bars), coverage, complete, sparse,
    reason: complete ? null : !results[3].rows.length && !results[1].rows.length ? 'no_market'
      : results[3].rows.every(row => row.status === 'unsupported') && !results[1].rows.length ? 'unsupported_decoder' : 'incomplete_chart_coverage' };
}

export function createNodeMarketService(options: { db: NodeMarketDatabase; rpc: Rpc; now?: () => number }) {
  const { db, rpc } = options, now = options.now ?? Date.now;
  async function eligibleTargetSql(column:string){
    if(!/^[a-z_.]+$/.test(column))throw new Error('invalid_market_column');
    const available=(await db.query("SELECT to_regclass('public.tokens') IS NOT NULL AS yes")).rows[0]?.yes;
    const metadata=available?`SELECT target.address,t.symbol,t.name FROM (VALUES(${column})) target(address) LEFT JOIN tokens t ON t.address=target.address`
      :`SELECT ${column} AS address,NULL::text AS symbol,NULL::text AS name`;
    return `EXISTS(SELECT 1 FROM (${metadata}) eligible_market_token WHERE ${kolProfileTokenSql('eligible_market_token')})`;
  }
  const blockJobs = new NodeMarketWorkCache<number,NodeMarketBlock>(1000), feedJobs = new NodeMarketWorkCache<string,string|null>(2000);
  const metaJobs = new NodeMarketWorkCache<string,{decimals:number;supply:string}|null>(2000);
  const call = async (to: string, abi: typeof erc20MarketAbi, method: string, args: unknown[], height: number) => {
    const checkpoint=await block(height);
    return abi.decodeFunctionResult(method, await rpc<string>('eth_call', [{ to, data: abi.encodeFunctionData(method, args) }, {blockHash:checkpoint.blockHash,requireCanonical:true}]));
  };
  const callMany=async(checkpoint:NodeMarketBlock,queries:{to:string;abi:typeof erc20MarketAbi;method:string;args:unknown[]}[])=>{
    const replies=await rpcBatch<string>(rpc,queries.map(query=>({method:'eth_call',params:[{
      to:query.to,data:query.abi.encodeFunctionData(query.method,query.args)},
      {blockHash:checkpoint.blockHash,requireCanonical:true}]})));
    return replies.map((reply,index)=>{if(reply.status!=='fulfilled')throw new Error('market_rpc_element_unavailable');
      return queries[index].abi.decodeFunctionResult(queries[index].method,reply.value);});
  };
  async function block(height: number): Promise<NodeMarketBlock> {
    if (!Number.isSafeInteger(height) || height < 0) throw new Error('invalid_market_block');
    const cached = blockJobs.get(height); if (cached) return cached;
    const job = (async () => {
      const raw = await rpc<{ number: string; hash: string; parentHash:string; timestamp: string }>('eth_getBlockByNumber', [blockHex(height), false]);
      if (!raw || Number(BigInt(raw.number)) !== height) throw new Error('market_block_mismatch');
      return { blockNumber: height, blockHash: hash(raw.hash),parentHash:hash(raw.parentHash), timestamp: new Date(Number(BigInt(raw.timestamp)) * 1000).toISOString() };
    })();
    blockJobs.set(height, job);
    try { return await job; } catch (error) { if(blockJobs.get(height)===job)blockJobs.delete(height); throw error; }
  }
  async function capturedCheckpoint(checkpoint:NodeMarketBlock) {
    if(!(await db.query("SELECT to_regclass('node_evidence_blocks') IS NOT NULL AS available")).rows[0]?.available)return false;
    const captured=(await db.query('SELECT block_hash,timestamp FROM node_evidence_blocks WHERE block_number=$1',[checkpoint.blockNumber])).rows[0];
    return !!captured&&hash(captured.block_hash)===checkpoint.blockHash&&Date.parse(dateText(captured.timestamp))===Date.parse(checkpoint.timestamp);
  }
  async function canonicalWrite<T>(checkpoint:NodeMarketBlock,write:(database:DB)=>Promise<T>,appendOnlyProof=false,persistedOnly=false) {
    // Historical backfills can precede permanent header capture. Fetch their
    // external guard before acquiring database locks; app reorgs are fenced by
    // the captured-header recheck inside the transaction below.
    const hasHeaders=persistedOnly||!!(await db.query("SELECT to_regclass('node_evidence_blocks') IS NOT NULL AS available")).rows[0]?.available;
    const before=!persistedOnly&&hasHeaders?(await db.query('SELECT block_hash,timestamp FROM node_evidence_blocks WHERE block_number=$1',[checkpoint.blockNumber])).rows[0]:null;
    let external:{number:string;hash:string;timestamp:string}|null=null;
    if(!persistedOnly&&!before){
      external=await rpc<{number:string;hash:string;timestamp:string}>('eth_getBlockByNumber',[blockHex(checkpoint.blockNumber),false]);
      if(!external||Number(BigInt(external.number))!==checkpoint.blockNumber||hash(external.hash)!==checkpoint.blockHash
        ||Number(BigInt(external.timestamp))*1000!==Date.parse(checkpoint.timestamp))throw new Error('market_canonical_checkpoint_changed');
    }
    const client=await db.connect();
    try {
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
      // Token/feed proofs are immutable keyed inserts. The rollback lock and
      // canonical hash check protect them; unrelated market-range transactions
      // must not delay urgent evidence beyond the node's state window.
      if(!appendOnlyProof)await client.query('SELECT pg_advisory_xact_lock(908335)');
      // Permanent captured headers are the canonical application proof, guarded
      // by the same rollback lock as raw evidence and other node projections.
      // Only historical market backfills preceding capture need another RPC.
      const captured=hasHeaders?(await client.query('SELECT block_hash,timestamp FROM node_evidence_blocks WHERE block_number=$1',[checkpoint.blockNumber])).rows[0]:null;
      if(captured){
        if(hash(captured.block_hash)!==checkpoint.blockHash||Date.parse(dateText(captured.timestamp))!==Date.parse(checkpoint.timestamp))throw new Error('market_canonical_checkpoint_changed');
      }else{
        if(persistedOnly||before||!external)throw new Error('market_canonical_checkpoint_unavailable');
      }
      const result=await write(client);await client.query('COMMIT');return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async function metadata(token: string, checkpoint: NodeMarketBlock,persistedOnly=false) {
    // Old raw decoding must never join an RPC-backed metadata job: genuine
    // captured precision is all that survives the node's historical state.
    if(persistedOnly){
      const prior=(await db.query(`SELECT decimals,supply::text FROM node_market_token_evidence
        WHERE token_address=$1 AND block_hash=$2 AND block_number=$3 AND timestamp=$4`,[token,checkpoint.blockHash,checkpoint.blockNumber,checkpoint.timestamp])).rows[0];
      return prior?{decimals:prior.decimals,supply:prior.supply}:null;
    }
    const key = `${token}:${checkpoint.blockHash}`; const cached = metaJobs.get(key); if (cached) return cached;
    const job = (async () => {
      const prior = (await db.query('SELECT decimals,supply::text FROM node_market_token_evidence WHERE token_address=$1 AND block_hash=$2', [token, checkpoint.blockHash])).rows[0];
      if (prior) return { decimals: prior.decimals, supply: prior.supply };
      try {
        const [precision,total]=await callMany(checkpoint,[{to:token,abi:erc20MarketAbi,method:'decimals',args:[]},{to:token,abi:erc20MarketAbi,method:'totalSupply',args:[]}]);
        const decimals = Number(precision[0]), raw = BigInt(total[0]);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || raw < 0n) return null;
        const supply = MarketDecimal.raw(raw, decimals).text();
        await canonicalWrite(checkpoint,async database=>{await database.query(`INSERT INTO node_market_token_evidence(token_address,block_number,block_hash,timestamp,decimals,total_supply_raw,supply)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [token, checkpoint.blockNumber, checkpoint.blockHash, checkpoint.timestamp, decimals, raw.toString(), supply]);
        },true);
        return { decimals, supply };
      } catch { return null; }
    })();
    metaJobs.set(key, job); const result=await job; if(!result&&metaJobs.get(key)===job) metaJobs.delete(key); return result;
  }
  async function convertedQuotePrice(quote:string,checkpoint:NodeMarketBlock,availability?:{discoveryUnavailable:boolean}):Promise<string|null> {
    const cached=(await db.query(`SELECT price_usd::text FROM node_market_quote_evidence WHERE quote_address=$1 AND block_hash=$2 AND schema_version=1`,[quote,checkpoint.blockHash])).rows[0];
    if(cached)return cached.price_usd;
    const routes:NodeQuoteConversionRoute[]=[],seen=new Set<string>();
    const prior=(await db.query(`SELECT evidence FROM node_market_quote_evidence WHERE quote_address=$1 AND schema_version=1
      AND block_number<=$2 AND timestamp<=$3 ORDER BY block_number DESC LIMIT 1`,[quote,checkpoint.blockNumber,checkpoint.timestamp])).rows[0]?.evidence;
    type Candidate={base:string;candidate:string};
    const priorDiscovery=prior?.routeDiscovery;
    const discoveryAge=Date.parse(checkpoint.timestamp)-Date.parse(String(priorDiscovery?.timestamp));
    const known:Candidate[]=Array.isArray(prior?.routeCandidates)&&prior.routeCandidates.length<=15&&discoveryAge>=0&&discoveryAge<60_000
      ?prior.routeCandidates.filter((row:any)=>typeof row?.pool==='string'&&/^0x[0-9a-f]{40}$/.test(row.pool)&&TRUSTED_QUOTE_FEEDS[row.base])
        .map((row:any)=>({base:row.base,candidate:row.pool})):[];
    const discoverCandidates=async()=>{const candidates:Candidate[]=[],calls:{base:string;method:'getPair'|'getPool';to:string;args:unknown[]}[]=[];
      for(const base of Object.keys(TRUSTED_QUOTE_FEEDS))for(const fee of [null,100,500,2500,10000])calls.push({base,method:fee===null?'getPair':'getPool',
        to:fee===null?PCS_V2_FACTORY:PCS_V3_FACTORY,args:fee===null?[quote,base]:[quote,base,fee]});
      const replies=await rpcBatch<string>(rpc,calls.map(item=>({method:'eth_call',params:[{to:item.to,data:poolMarketAbi.encodeFunctionData(item.method,item.args)},
        {blockHash:checkpoint.blockHash,requireCanonical:true}]})));
      if(availability)availability.discoveryUnavailable=replies.length===calls.length&&replies.every(reply=>reply.status==='rejected');
      for(let index=0;index<calls.length;index++)try{const reply=replies[index];if(reply.status!=='fulfilled')continue;
        const candidate=String(poolMarketAbi.decodeFunctionResult(calls[index].method,reply.value)[0]).toLowerCase();
        if(candidate!==ZeroAddress)candidates.push({base:calls[index].base,candidate});
      }catch{/* Invalid or unavailable elements never provide a price. */}
      return candidates;
    };
    // Exactly one hop: every candidate's opposite asset must have a pinned USD
    // feed. A converted quote is never recursively used as another route base.
    const evaluate=async(candidates:Candidate[])=>{for(const {base,candidate} of candidates) {
      try {
        if(candidate===ZeroAddress||seen.has(candidate))continue;seen.add(candidate);
        const market=await authenticatePool(quote,candidate,checkpoint);if(!market||market.quote!==base)continue;
        const baseUsd=await feedPrice(base,checkpoint);if(!baseUsd)continue;
        const quoteIs0=market.token0===quote,quoteDecimals=quoteIs0?market.decimals0:market.decimals1,baseDecimals=quoteIs0?market.decimals1:market.decimals0;
        let rawQuote:bigint,rawBase:bigint,priceBase:string|null,state:Record<string,string>;
        if(market.protocol==='pcs_v2') {
          const reserves=await call(candidate,poolMarketAbi,'getReserves',[],checkpoint.blockNumber);
          rawQuote=BigInt(quoteIs0?reserves[0]:reserves[1]);rawBase=BigInt(quoteIs0?reserves[1]:reserves[0]);
          priceBase=ratioPrice(rawBase,rawQuote,baseDecimals,quoteDecimals);
          state={reserve0:String(reserves[0]),reserve1:String(reserves[1]),reserveTimestamp:String(reserves[2])};
        } else {
          const [slot,liquidity,quoteBalance,baseBalance]=await callMany(checkpoint,[
            {to:candidate,abi:poolMarketAbi,method:'slot0',args:[]},{to:candidate,abi:poolMarketAbi,method:'liquidity',args:[]},
            {to:quote,abi:erc20MarketAbi,method:'balanceOf',args:[candidate]},{to:base,abi:erc20MarketAbi,method:'balanceOf',args:[candidate]}]);
          if(BigInt(liquidity[0])<=0n)continue;
          rawQuote=BigInt(quoteBalance[0]);rawBase=BigInt(baseBalance[0]);
          priceBase=sqrtPrice(BigInt(slot[0]),quoteIs0,market.decimals0,market.decimals1);
          state={sqrtPriceX96:String(slot[0]),tick:String(slot[1]),liquidity:String(liquidity[0]),quoteBalanceRaw:rawQuote.toString(),baseBalanceRaw:rawBase.toString()};
        }
        if(rawQuote<=0n||rawBase<=0n||!priceBase)continue;
        const priceUsd=MarketDecimal.parse(priceBase).mul(MarketDecimal.parse(baseUsd)).text();
        const baseDepth=MarketDecimal.raw(rawBase,baseDecimals).mul(MarketDecimal.parse(baseUsd));
        const quoteDepth=MarketDecimal.raw(rawQuote,quoteDecimals).mul(MarketDecimal.parse(priceUsd));
        const depthUsd=(baseDepth.compare(quoteDepth)<0?baseDepth:quoteDepth).text();
        routes.push({pool:candidate,protocol:market.protocol as 'pcs_v2'|'pcs_v3',base,priceUsd,depthUsd,
          evidence:{version:1,authentication:market.authentication,token0:market.token0,token1:market.token1,decimals0:market.decimals0,decimals1:market.decimals1,
            state,basePriceUsd:baseUsd,baseFeed:TRUSTED_QUOTE_FEEDS[base].feed,baseFeedDescription:TRUSTED_QUOTE_FEEDS[base].description,
            baseObservation:await persistedQuoteProof(base,checkpoint,baseUsd),
            blockNumber:checkpoint.blockNumber,blockHash:checkpoint.blockHash,timestamp:checkpoint.timestamp}});
      }catch {/* An absent, zero-state or unverifiable route supplies no price. */}
    }};
    // Reuse only a short-lived pool candidate catalogue. Every price still
    // authenticates the factory and reads precision, liquidity/state and USD
    // evidence at this exact canonical block. Discover all routes periodically
    // and immediately when the known candidates no longer authorize a mark.
    let routeDiscovery=known.length?priorDiscovery:{blockNumber:checkpoint.blockNumber,blockHash:checkpoint.blockHash,timestamp:checkpoint.timestamp};
    await evaluate(known.length?known:await discoverCandidates());
    let selected=selectNodeQuoteConversion(routes);
    if(!selected&&known.length){routes.length=0;seen.clear();await evaluate(await discoverCandidates());selected=selectNodeQuoteConversion(routes);
      routeDiscovery={blockNumber:checkpoint.blockNumber,blockHash:checkpoint.blockHash,timestamp:checkpoint.timestamp};}
    if(!selected)return null;
    selected.evidence={...selected.evidence,routeCandidates:routes.map(route=>({pool:route.pool,base:route.base})),routeDiscovery};
    await canonicalWrite(checkpoint,async database=>{await database.query(`INSERT INTO node_market_quote_evidence
      (quote_address,block_number,block_hash,timestamp,price_usd,base_quote_address,pool_address,protocol,depth_usd,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING`,
      [quote,checkpoint.blockNumber,checkpoint.blockHash,checkpoint.timestamp,selected.priceUsd,selected.base,selected.pool,selected.protocol,selected.depthUsd,JSON.stringify(selected.evidence)]);});
    return selected.priceUsd;
  }
  async function persistedQuoteProof(quote:string,checkpoint:NodeMarketBlock,expectedPrice?:string,canonicalOnly=false) {
    const config=TRUSTED_QUOTE_FEEDS[quote];
    const canonical=(alias:string)=>canonicalOnly?`JOIN node_evidence_blocks canonical ON canonical.block_number=${alias}.block_number
      AND canonical.block_hash=${alias}.block_hash AND canonical.timestamp=${alias}.timestamp`:'';
    // Bound each native-typed source by its observation index before merging.
    // Casting heights to text inside UNION used to force repeated full-history
    // scans for every swap, even though only a two-minute proof is eligible.
    const row=(await db.query(`SELECT proof.* FROM (
      (SELECT 'feed'::text AS kind,f.price_usd::text,f.block_number,f.block_hash,f.timestamp,f.updated_at,
        jsonb_build_object('feed',f.feed_address,'description',f.feed_description,'roundId',f.round_id::text,'answerRaw',f.answer_raw::text,'decimals',f.feed_decimals) AS evidence
        FROM node_market_feed_evidence f ${canonical('f')}
        WHERE f.quote_address=$1 AND f.feed_address=$4 AND f.feed_description=$5 AND f.block_number<=$2::bigint
          AND f.timestamp BETWEEN $3::timestamptz-interval '2 minutes' AND $3::timestamptz
          AND ($6::numeric IS NULL OR f.price_usd=$6::numeric)
        ORDER BY f.timestamp DESC,f.block_number DESC LIMIT 1)
      UNION ALL
      (SELECT 'pool_conversion',q.price_usd::text,q.block_number,q.block_hash,q.timestamp,q.timestamp,q.evidence
        FROM node_market_quote_evidence q ${canonical('q')}
        WHERE q.quote_address=$1 AND q.schema_version=1 AND q.block_number<=$2::bigint
          AND q.timestamp BETWEEN $3::timestamptz-interval '2 minutes' AND $3::timestamptz
          AND ($6::numeric IS NULL OR q.price_usd=$6::numeric)
        ORDER BY q.timestamp DESC,q.block_number DESC LIMIT 1)
      ) proof ORDER BY proof.timestamp DESC,proof.block_number DESC LIMIT 1`,
    [quote,checkpoint.blockNumber,checkpoint.timestamp,config?.feed??null,config?.description??null,expectedPrice??null])).rows[0];
    return row?{...row,timestamp:dateText(row.timestamp),updated_at:dateText(row.updated_at)}:null;
  }
  async function feedPrice(quote: string, checkpoint: NodeMarketBlock,persistedOnly=false): Promise<string | null> {
    // The hot decoder resumes old logs using original dated proofs only.
    // Route discovery/state repair belongs to the separately paced capture job.
    if(persistedOnly)return (await persistedQuoteProof(quote,checkpoint,undefined,true))?.price_usd??null;
    const config = TRUSTED_QUOTE_FEEDS[quote];
    const key = `${quote}:${checkpoint.blockHash}`, cached = feedJobs.get(key); if (cached) return cached;
    let usedFallback=false;
    const job = (async () => {
      if(!config){
        const availability={discoveryUnavailable:false};
        const converted=await convertedQuotePrice(quote,checkpoint,availability);
        // Reuse the original, dated proof only when the node cannot answer the
        // bounded route scan. A successful contradictory/zero-state scan must
        // never be hidden by an older quote, and no new conversion proof is made.
        if(converted)return converted;
        const prior=availability.discoveryUnavailable?await persistedQuoteProof(quote,checkpoint):null;
        usedFallback=!!prior;return prior?.price_usd??null;
      }
      const prior = (await db.query('SELECT price_usd::text FROM node_market_feed_evidence WHERE quote_address=$1 AND block_hash=$2 AND feed_description=$3', [quote, checkpoint.blockHash,config.description])).rows[0];
      if (prior) return prior.price_usd;
      try {
        const [precision,round,description]=await callMany(checkpoint,[{to:config.feed,abi:oracleMarketAbi,method:'decimals',args:[]},
          {to:config.feed,abi:oracleMarketAbi,method:'latestRoundData',args:[]},{to:config.feed,abi:oracleMarketAbi,method:'description',args:[]}]);
        const decimals = Number(precision[0]), answer = BigInt(round.answer), updated = Number(round.updatedAt);
        const observed = Date.parse(checkpoint.timestamp) / 1000;
        if (String(description[0])!==config.description||decimals < 0 || decimals > 36 || answer <= 0n || updated <= 0 || updated > observed || observed - updated > config.maxAgeSeconds || BigInt(round.answeredInRound) < BigInt(round.roundId)) return null;
        const price = MarketDecimal.raw(answer, decimals).text();
        await canonicalWrite(checkpoint,async database=>{await database.query(`INSERT INTO node_market_feed_evidence(quote_address,feed_address,block_number,block_hash,timestamp,round_id,answered_in_round,answer_raw,feed_decimals,price_usd,updated_at,feed_description)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11),$12) ON CONFLICT(quote_address,block_hash) DO UPDATE SET feed_description=EXCLUDED.feed_description
          WHERE node_market_feed_evidence.feed_address=EXCLUDED.feed_address AND node_market_feed_evidence.answer_raw=EXCLUDED.answer_raw AND node_market_feed_evidence.feed_decimals=EXCLUDED.feed_decimals`,
        [quote, config.feed, checkpoint.blockNumber, checkpoint.blockHash, checkpoint.timestamp, String(round.roundId), String(round.answeredInRound), answer.toString(), decimals, price, updated,config.description]);},true);
        return price;
      } catch {const prior=await persistedQuoteProof(quote,checkpoint);usedFallback=!!prior&&prior.block_hash!==checkpoint.blockHash;return prior?.price_usd??null;}
    })();
    feedJobs.set(key, job); const result=await job; if((!result||usedFallback)&&feedJobs.get(key)===job) feedJobs.delete(key); return result;
  }
  async function register(market: NodeMarketIdentity, checkpoint: NodeMarketBlock, status: 'active' | 'unsupported' = 'active') {
    await canonicalWrite(checkpoint,async database=>{await database.query(`INSERT INTO node_markets(id,token_address,quote_address,protocol,contract_address,pool_id,token0,token1,decimals0,decimals1,authenticated_at_block,authenticated_block_hash,authentication,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
      ON CONFLICT(id) DO UPDATE SET decimals0=EXCLUDED.decimals0,decimals1=EXCLUDED.decimals1,authentication=EXCLUDED.authentication,
        status=CASE WHEN node_markets.status='graduated' THEN node_markets.status ELSE EXCLUDED.status END`,
    [market.id, market.token, market.quote, market.protocol, market.contract, market.poolId, market.token0, market.token1, market.decimals0, market.decimals1,
      checkpoint.blockNumber, checkpoint.blockHash, JSON.stringify(market.authentication), status]);});
  }
  async function authenticatePool(token: string, pool: string, checkpoint: NodeMarketBlock): Promise<NodeMarketIdentity | null> {
    try {
      const [f,a,b]=await callMany(checkpoint,[{to:pool,abi:poolMarketAbi,method:'factory',args:[]},
        {to:pool,abi:poolMarketAbi,method:'token0',args:[]},{to:pool,abi:poolMarketAbi,method:'token1',args:[]}]);
      const factory = address(String(f[0])), token0 = address(String(a[0])), token1 = address(String(b[0]));
      if (token0 === token1 || ![token0, token1].includes(token) || ![PCS_V2_FACTORY, PCS_V3_FACTORY].includes(factory)) return null;
      const quote = token0 === token ? token1 : token0;
      let expected: string, fee: number | null = null;
      if (factory === PCS_V2_FACTORY) expected = String((await call(factory, poolMarketAbi, 'getPair', [token0,token1], checkpoint.blockNumber))[0]).toLowerCase();
      else { fee = Number((await call(pool, poolMarketAbi, 'fee', [], checkpoint.blockNumber))[0]); expected = String((await call(factory, poolMarketAbi, 'getPool', [token0,token1,fee], checkpoint.blockNumber))[0]).toLowerCase(); }
      if (expected !== pool) return null;
      const [meta0,meta1] = await Promise.all([metadata(token0, checkpoint),metadata(token1, checkpoint)]); if (!meta0 || !meta1) return null;
      return { id: `${pool}:${token}`, token, quote, protocol: factory === PCS_V2_FACTORY ? 'pcs_v2' : 'pcs_v3', contract: pool, poolId: null,
        token0, token1, decimals0: meta0.decimals, decimals1: meta1.decimals, authentication: { factory, fee, canonicalFactoryLookup: true } };
    } catch { return null; }
  }
  async function authenticateInfinity(token: string, poolId: string, controller: string, checkpoint: NodeMarketBlock): Promise<NodeMarketIdentity | null> {
    try {
      const key = await call(controller, infinityMarketAbi, 'poolIdToPoolKey', [poolId], checkpoint.blockNumber);
      if (!authenticatedPoolKey(poolId, controller, [...key])) return null;
      const token0 = String(key.currency0).toLowerCase() === ZeroAddress ? WBNB : address(String(key.currency0));
      const token1 = String(key.currency1).toLowerCase() === ZeroAddress ? WBNB : address(String(key.currency1));
      if (![token0, token1].includes(token) || token0 === token1) return null;
      const quote = token0 === token ? token1 : token0;
      const [meta0,meta1] = await Promise.all([metadata(token0, checkpoint),metadata(token1, checkpoint)]); if (!meta0 || !meta1) return null;
      return { id: `${controller}:${poolId}:${token}`, token, quote, protocol: controller === INFINITY_CL ? 'infinity_cl' : 'infinity_bin', contract: controller, poolId,
        token0, token1, decimals0: meta0.decimals, decimals1: meta1.decimals,
        authentication: { poolKeyHash: poolId, hooks: String(key.hooks).toLowerCase(), fee: String(key.fee), parameters: String(key.parameters), poolManager: controller } };
    } catch { return null; }
  }
  async function discover(tokenAddress: string, checkpoint: NodeMarketBlock & { logs?: Pick<NodeMarketLog, 'address'|'topics'|'data'>[] }) {
    const token = address(tokenAddress), candidates = new Set<string>(), infinity = new Set<string>();
    hash(checkpoint.blockHash); iso(checkpoint.timestamp);
    const eligible=await eligibleTargetSql('target.address');
    if(!(await db.query(`SELECT ${eligible} AS yes FROM (VALUES($1::text)) target(address)`,[token])).rows[0]?.yes)return [];
    for (const log of checkpoint.logs ?? []) {
      // Receipt log contracts are candidates only: factory lookups authenticate
      // them independently before registration.
      if (protocolMarketTopics.includes(log.topics[0])) candidates.add(log.address.toLowerCase());
      const launch = parseLaunchLog(log, new Set([token]));
      if (launch?.pool && /^0x[0-9a-f]{40}$/.test(launch.pool)) candidates.add(launch.pool);
      if (launch?.poolId) infinity.add(launch.poolId);
      if ([INFINITY_CL,INFINITY_BIN].includes(log.address.toLowerCase()) && /^0x[0-9a-f]{64}$/i.test(log.topics[1] ?? '')) infinity.add(log.topics[1].toLowerCase());
    }
    const registered: string[] = [];
    for (const pool of [...candidates].filter(pool => ![...FOUR_MANAGERS,FLAP_PORTAL,INFINITY_CL,INFINITY_BIN].includes(pool)).slice(0,24)) {
      const market = await authenticatePool(token,pool,checkpoint); if (market) { await register(market,checkpoint); registered.push(market.id); }
    }
    // Direct discovery works even when the tracked purchase used a router or
    // its receipt is not yet decoded.
    for (const quote of Object.keys(TRUSTED_QUOTE_FEEDS).filter(q => q !== token)) {
      for (const fee of [null,100,500,2500,10000]) {
        try {
          const pool = String((await call(fee === null ? PCS_V2_FACTORY : PCS_V3_FACTORY,poolMarketAbi,
            fee === null ? 'getPair' : 'getPool',fee === null ? [token,quote] : [token,quote,fee],checkpoint.blockNumber))[0]).toLowerCase();
          if (pool === ZeroAddress || candidates.has(pool)) continue;
          const market = await authenticatePool(token,pool,checkpoint); if (market) { await register(market,checkpoint); registered.push(market.id); }
        } catch { /* An unsupported factory/pool cannot become trusted evidence. */ }
      }
    }
    for (const poolId of infinity) for (const controller of [INFINITY_CL,INFINITY_BIN]) {
      const market = await authenticateInfinity(token,poolId,controller,checkpoint); if (market) { await register(market,checkpoint); registered.push(market.id); }
    }
    const tokenMeta = await metadata(token,checkpoint);
    if (tokenMeta) {
      try {
        const info = await call(FOUR_HELPER,fourInterface,'getTokenInfo',[token],checkpoint.blockNumber);
        const manager = String(info.tokenManager).toLowerCase(), quote = String(info.quote).toLowerCase() === ZeroAddress ? WBNB : address(String(info.quote));
        if ([1n,2n].includes(BigInt(info.version)) && FOUR_MANAGERS.includes(manager)) {
          const quoteMeta = await metadata(quote,checkpoint);
          if (quoteMeta) { const market: NodeMarketIdentity = { id: `${manager}:${token}`,token,quote,protocol:'fourmeme',contract:manager,poolId:null,token0:token,token1:quote,
            decimals0:tokenMeta.decimals,decimals1:quoteMeta.decimals,authentication:{ controller:manager,version:String(info.version),helper:FOUR_HELPER } };
            await register(market,checkpoint,tokenMeta.decimals === 18 ? 'active' : 'unsupported');
            if (info.liquidityAdded) await db.query("UPDATE node_markets SET status='graduated' WHERE id=$1",[market.id]); registered.push(market.id); }
        }
      } catch { /* This token may use another launchpad or an unknown version. */ }
      for (const method of ['getTokenV8Safe','getTokenV7'] as const) {
        try {
          const info = (await call(FLAP_PORTAL,flapInterface,method,[token],checkpoint.blockNumber))[0];
          if (BigInt(info.status) === 0n) continue;
          const quote = String(info.quoteTokenAddress).toLowerCase() === ZeroAddress ? WBNB : address(String(info.quoteTokenAddress));
          const quoteMeta = await metadata(quote,checkpoint); if (!quoteMeta) break;
          const market: NodeMarketIdentity = { id:`${FLAP_PORTAL}:${token}`,token,quote,protocol:'flap',contract:FLAP_PORTAL,poolId:null,token0:token,token1:quote,
            decimals0:tokenMeta.decimals,decimals1:quoteMeta.decimals,authentication:{controller:FLAP_PORTAL,method,tokenVersion:String(info.tokenVersion)} };
          await register(market,checkpoint,tokenMeta.decimals === 18 && [1n,4n].includes(BigInt(info.status)) ? 'active' : 'unsupported');
          if (BigInt(info.status) === 4n) await db.query("UPDATE node_markets SET status='graduated' WHERE id=$1",[market.id]);
          registered.push(market.id);
          if (BigInt(info.status) === 4n && String(info.pool).toLowerCase() !== ZeroAddress) {
            const pool = await authenticatePool(token,String(info.pool).toLowerCase(),checkpoint); if (pool) { await register(pool,checkpoint); registered.push(pool.id); }
          }
          break;
        } catch { /* Try the previous documented Portal interface. */ }
      }
    }
    return [...new Set(registered)];
  }
  async function storeObservation(market: NodeMarketIdentity, checkpoint: NodeMarketBlock, details: {
    id: string; kind: 'swap'|'state'; priceQuote: string; tokenAmountRaw?: string; quoteAmountRaw?: string; log?: NodeMarketLog;
  },persistedOnly=false) {
    if(persistedOnly&&!await capturedCheckpoint(checkpoint))return false;
    const quote = await feedPrice(market.quote,checkpoint,persistedOnly); if (!quote || !positiveDecimal(details.priceQuote)) return false;
    const price = MarketDecimal.parse(details.priceQuote).mul(MarketDecimal.parse(quote)).text();
    const [meta,quoteMeta] = await Promise.all([metadata(market.token,checkpoint,persistedOnly),metadata(market.quote,checkpoint,persistedOnly)]);
    if(!meta||!quoteMeta)return false;
    const volume = details.kind === 'swap' && details.quoteAmountRaw
      ? MarketDecimal.raw(BigInt(details.quoteAmountRaw),market.token0 === market.token ? market.decimals1 : market.decimals0).mul(MarketDecimal.parse(quote)).text() : null;
    const quoteEvidence=await persistedQuoteProof(market.quote,checkpoint,quote,persistedOnly);if(!quoteEvidence)return false;
    await canonicalWrite(checkpoint,async database=>{await database.query(`INSERT INTO node_market_observations(id,token_address,market_id,kind,source,timestamp,block_number,block_hash,tx_hash,transaction_index,log_index,
      price_usd,quote_price_usd,token_amount_raw,quote_amount_raw,volume_usd,supply,supply_estimated,quote_evidence)
      VALUES($1,$2,$3,$4,'node',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb) ON CONFLICT(id) DO NOTHING`,
    [details.id,market.token,market.id,details.kind,checkpoint.timestamp,checkpoint.blockNumber,checkpoint.blockHash,details.log?.transactionHash.toLowerCase() ?? null,
      details.log ? Number(BigInt(details.log.transactionIndex)) : null,details.log ? Number(BigInt(details.log.logIndex)) : null,price,quote,
      details.tokenAmountRaw ?? null,details.quoteAmountRaw ?? null,volume,meta?.supply ?? null,!meta,JSON.stringify(quoteEvidence)]);},true,persistedOnly);
    return true;
  }
  async function rebuildCandles(database: DB, token: string, from: string, to: string) {
    await database.query(`DELETE FROM node_market_candles WHERE token_address=$1 AND minute>=date_trunc('minute',$2::timestamptz) AND minute<=date_trunc('minute',$3::timestamptz)`, [token,from,to]);
    await database.query(`INSERT INTO node_market_candles(token_address,market_id,minute,open,high,low,close,volume_usd,observations,first_observation_at,last_observation_at)
      SELECT token_address,market_id,date_trunc('minute',timestamp),
        (array_agg(price_usd ORDER BY timestamp,block_number,transaction_index,log_index))[1],max(price_usd),min(price_usd),
        (array_agg(price_usd ORDER BY timestamp DESC,block_number DESC,transaction_index DESC,log_index DESC))[1],
        sum(COALESCE(volume_usd,0)),count(*),min(timestamp),max(timestamp)
      FROM node_market_observations WHERE token_address=$1 AND kind='swap' AND timestamp>=date_trunc('minute',$2::timestamptz)
        AND timestamp<date_trunc('minute',$3::timestamptz)+interval '1 minute' GROUP BY token_address,market_id,date_trunc('minute',timestamp)
      ON CONFLICT(token_address,market_id,minute) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
        volume_usd=EXCLUDED.volume_usd,observations=EXCLUDED.observations,first_observation_at=EXCLUDED.first_observation_at,last_observation_at=EXCLUDED.last_observation_at`, [token,from,to]);
  }
  async function decodePending(limit = 300,options:{minimumBlock?:number;allowCapturedOlder?:boolean;maxDurationMs?:number;databaseOnly?:boolean}={}) {
    // A session lease coalesces independent API/worker processes without
    // holding a database transaction or row locks during node RPC.
    const lease=await db.connect();let locked=false;
    try{
      locked=!!(await lease.query('SELECT pg_try_advisory_lock(908336) AS locked')).rows[0]?.locked;
      if(!locked)return{examined:0,decoded:0,coalesced:true};
      return await decodePendingWork(limit,options);
    }finally{try{if(locked)await lease.query('SELECT pg_advisory_unlock(908336)');}finally{lease.release();}}
  }
  async function decodePendingWork(limit:number,options:{minimumBlock?:number;allowCapturedOlder?:boolean;maxDurationMs?:number;databaseOnly?:boolean}) {
    const cycleBegan=performance.now();
    const eligible=await eligibleTargetSql('m.token_address');
    const cap=Math.max(1,Math.min(2000,limit));
    const columns=`l.*,m.*,(l.log) AS raw_log,l.timestamp AS observed_at,l.block_number AS observed_block,l.block_hash AS observed_hash`;
    let selectedRows:any[];
    type DecodeCursor={block:string;transactionIndex:number;logIndex:number;market:string;transaction:string;hash:string};
    const recovery:{status:string;keys:any[];eligible:Set<string>;previous:DecodeCursor|null}[]=[];
    let persistedProgress=false;
    let nextLane=0,nextRecoveryLane=0;
    const recoveryKey=(row:any)=>`${row.market_id}:${row.block_hash??row.observed_hash}:${row.tx_hash}:${row.log_index}`;
    if(options.minimumBlock!==undefined){
      const proof=`(l.block_number>=$2 OR $3::boolean AND EXISTS(SELECT 1 FROM node_market_token_evidence p WHERE p.token_address=m.token0 AND p.block_hash=l.block_hash)
        AND EXISTS(SELECT 1 FROM node_market_token_evidence p WHERE p.token_address=m.token1 AND p.block_hash=l.block_hash))`;
      const parameters=[cap,options.minimumBlock,!!options.allowCapturedOlder];
      const [fresh,selected]=await Promise.all([
        db.query(`SELECT ${columns} FROM node_market_raw_logs l JOIN node_markets m ON m.id=l.market_id
          WHERE l.decode_status='pending' AND l.block_number>=$2 AND m.status<>'unsupported' AND ${eligible}
          ORDER BY l.block_number,l.transaction_index,l.log_index LIMIT $1`,parameters.slice(0,2)),
        db.query(`WITH windows AS(SELECT token_address,from_at,to_at,priority,requested_at FROM node_market_history_jobs
          WHERE expires_at>now() ORDER BY priority DESC,requested_at LIMIT 32), candidates AS(
          SELECT r.market_id,r.block_hash,r.tx_hash,r.log_index,max(j.priority) priority,min(j.requested_at) requested_at
          FROM windows j JOIN node_markets m ON m.token_address=j.token_address AND m.status<>'unsupported'
          CROSS JOIN LATERAL(SELECT l.market_id,l.block_hash,l.tx_hash,l.log_index FROM node_market_raw_logs l
            WHERE l.market_id=m.id AND l.timestamp BETWEEN j.from_at AND j.to_at AND ${eligible}
              AND l.decode_status IN('pending','missing_quote') AND l.block_number<$2
              AND ${proof} ORDER BY l.timestamp,l.block_number,l.transaction_index,l.log_index LIMIT $1)r
          GROUP BY r.market_id,r.block_hash,r.tx_hash,r.log_index)
          SELECT ${columns} FROM candidates c JOIN node_market_raw_logs l USING(market_id,block_hash,tx_hash,log_index)
          JOIN node_markets m ON m.id=l.market_id ORDER BY c.priority DESC,c.requested_at,l.block_number,l.transaction_index,l.log_index LIMIT $1`,parameters)
      ]);
      const key=(row:any)=>`${row.market_id}:${row.observed_hash}:${row.tx_hash}:${row.log_index}`;
      const historical=[...selected.rows],backgroundRows:any[]=[],seen=new Set(historical.map(key));
      {
        // Recovery needs a reserved selection budget even when current and
        // selected windows fill the decode cap. Otherwise a busy market can
        // leave already captured observations behind forever.
        const recoveryCapacity=Math.max(1,Math.floor(cap/4),cap-historical.length-fresh.rows.length);
        const recentCapacity=Math.max(1,Math.floor(recoveryCapacity/2));
        const recoveryLanes:any[][]=[[],[],[],[]];
        // Proof capture normally finishes after the first raw decode attempt.
        // Revisit newly ready recent failures independently of a legacy cursor
        // that may already have passed their heights. Bound raw keys first.
        const hasCanonical=(await db.query("SELECT to_regclass('node_evidence_blocks') IS NOT NULL AS available")).rows[0]?.available;
        const recentKeys=hasCanonical?(await db.query(`SELECT market_id,block_hash,tx_hash,log_index FROM node_market_raw_logs
          WHERE decode_status='missing_quote' AND block_number>=GREATEST(0,$1::bigint-1024)
          ORDER BY block_number DESC,transaction_index DESC,log_index DESC LIMIT $2`,[options.minimumBlock,Math.max(128,cap*4)])).rows:[];
        const recentReady=recentKeys.length?(await db.query(`SELECT ${columns} FROM jsonb_to_recordset($1::jsonb)
          candidate(market_id text,block_hash text,tx_hash text,log_index integer)
          JOIN node_market_raw_logs l USING(market_id,block_hash,tx_hash,log_index) JOIN node_markets m ON m.id=l.market_id
          JOIN node_evidence_blocks canonical ON canonical.block_number=l.block_number AND canonical.block_hash=l.block_hash AND canonical.timestamp=l.timestamp
          WHERE l.decode_status='missing_quote' AND m.status<>'unsupported' AND ${eligible}
            AND EXISTS(SELECT 1 FROM node_market_token_evidence p WHERE p.token_address=m.token0 AND p.block_hash=l.block_hash)
            AND EXISTS(SELECT 1 FROM node_market_token_evidence p WHERE p.token_address=m.token1 AND p.block_hash=l.block_hash)
            AND(EXISTS(SELECT 1 FROM node_market_feed_evidence f JOIN node_evidence_blocks b ON b.block_number=f.block_number
              AND b.block_hash=f.block_hash AND b.timestamp=f.timestamp WHERE f.quote_address=m.quote_address
              AND f.feed_address=($2::jsonb->m.quote_address->>'feed') AND f.feed_description=($2::jsonb->m.quote_address->>'description')
              AND f.block_number<=l.block_number AND f.timestamp BETWEEN l.timestamp-interval '2 minutes' AND l.timestamp)
              OR EXISTS(SELECT 1 FROM node_market_quote_evidence q JOIN node_evidence_blocks b ON b.block_number=q.block_number
                AND b.block_hash=q.block_hash AND b.timestamp=q.timestamp WHERE q.quote_address=m.quote_address AND q.schema_version=1
                AND q.block_number<=l.block_number AND q.timestamp BETWEEN l.timestamp-interval '2 minutes' AND l.timestamp))
          ORDER BY l.block_number,l.transaction_index,l.log_index LIMIT $3`,[JSON.stringify(recentKeys),JSON.stringify(TRUSTED_QUOTE_FEEDS),recentCapacity])).rows:[];
        for(const row of recentReady)if(!seen.has(key(row))){recoveryLanes[0].push(row);seen.add(key(row));}
        persistedProgress=!!(await db.query("SELECT to_regclass('worker_state') IS NOT NULL AS available")).rows[0]?.available;
        const cursors=persistedProgress?(await db.query("SELECT value FROM worker_state WHERE key='node_market_decode_recovery'")).rows[0]?.value??{}:{};
        nextLane=Number.isInteger(cursors.nextLane)&&cursors.nextLane>=0&&cursors.nextLane<4?cursors.nextLane:0;
        nextRecoveryLane=Number.isInteger(cursors.nextRecoveryLane)&&cursors.nextRecoveryLane>=0&&cursors.nextRecoveryLane<4?cursors.nextRecoveryLane:0;
        const cohortLimit=Math.max(1,Math.floor((recoveryCapacity-recentCapacity)/3));
        // Bound raw candidates before precision/eligibility joins. Independent
        // status scans use the existing (decode_status,block_number) index; a
        // cursor cycles past unavailable old evidence without a full CASE sort.
        for(const [statusIndex,status] of ['pending','missing_quote','unsupported'].entries()){
          const prior=cursors[status] as DecodeCursor|undefined;
          const cursor=prior&&/^\d+$/.test(prior.block)&&Number.isSafeInteger(prior.transactionIndex)&&Number.isSafeInteger(prior.logIndex)
            &&typeof prior.market==='string'&&typeof prior.transaction==='string'&&typeof prior.hash==='string'?prior:null;
          const loadCohort=(position:DecodeCursor|null)=>db.query(`SELECT market_id,block_hash,tx_hash,log_index,block_number::text,transaction_index
            FROM node_market_raw_logs WHERE decode_status=$1 AND ($2::bigint IS NULL OR block_number<$2)
              AND ($4::bigint IS NULL OR block_number<=$4 AND (block_number,transaction_index,log_index,market_id,tx_hash,block_hash)
                <($4::bigint,$5::integer,$6::integer,$7::text,$8::text,$9::text))
            ORDER BY node_market_raw_logs.block_number DESC,transaction_index DESC,log_index DESC,market_id DESC,tx_hash DESC,block_hash DESC LIMIT $3`,
          [status,status==='pending'?options.minimumBlock:null,cohortLimit,position?.block??null,position?.transactionIndex??null,position?.logIndex??null,
            position?.market??null,position?.transaction??null,position?.hash??null]);
          let cohort=(await loadCohort(cursor)).rows;
          if(!cohort.length&&cursor)cohort=(await loadCohort(null)).rows;
          const ready=cohort.length?(await db.query(`SELECT ${columns} FROM jsonb_to_recordset($1::jsonb)
            candidate(market_id text,block_hash text,tx_hash text,log_index integer)
            JOIN node_market_raw_logs l USING(market_id,block_hash,tx_hash,log_index) JOIN node_markets m ON m.id=l.market_id
            WHERE ${proof} AND (l.decode_status IN('pending','missing_quote') OR l.decode_status='unsupported' AND l.decoder_version<$4
              AND l.log->'topics'->>0=ANY($5::text[])) AND m.status<>'unsupported' AND ${eligible}
            ORDER BY l.block_number DESC,l.transaction_index DESC,l.log_index DESC,l.market_id DESC,l.tx_hash DESC,l.block_hash DESC`,
          [JSON.stringify(cohort),options.minimumBlock,!!options.allowCapturedOlder,nodeMarketDecoderVersion,protocolMarketTopics])).rows:[];
          recovery.push({status,keys:cohort,eligible:new Set(ready.map(recoveryKey)),previous:cursor});
          for(const row of ready)if(!seen.has(key(row))){recoveryLanes[statusIndex+1].push(row);seen.add(key(row));}
        }
        // A busy recent retry queue must not consume the recovery lane itself.
        // Its subcursor advances only when a row is actually examined, just
        // like the outer selected/current/recovery cursor.
        const recoveryIndices=[0,0,0,0];let lane=nextRecoveryLane;
        while(backgroundRows.length<recoveryCapacity){
          let chosen=-1;
          for(let offset=0;offset<4;offset++){
            const candidate=(lane+offset)%4;
            if(recoveryIndices[candidate]<recoveryLanes[candidate].length){chosen=candidate;break;}
          }
          if(chosen<0)break;
          backgroundRows.push({...recoveryLanes[chosen][recoveryIndices[chosen]++],decode_next_recovery_lane:(chosen+1)%4});lane=(chosen+1)%4;
        }
      }
      // Selected history has two slots; current and recovery each have one.
      // Persist the next slot after the last examined row, rather than after
      // selection: a short deadline must not restart before recovery every
      // cycle. Empty lanes immediately lend their slots to available work.
      const lanes=[historical,historical,fresh.rows,backgroundRows],indices=[0,0,0,0];
      selectedRows=[];let lane=nextLane;
      while(selectedRows.length<cap){
        let chosen=-1;
        for(let offset=0;offset<4;offset++){
          const candidate=(lane+offset)%4,position=candidate<2?indices[0]:indices[candidate];
          if(position<lanes[candidate].length){chosen=candidate;break;}
        }
        if(chosen<0)break;
        const index=chosen<2?indices[0]++:indices[chosen]++;
        selectedRows.push({...lanes[chosen][index],decode_next_lane:(chosen+1)%4});lane=(chosen+1)%4;
      }
    }else selectedRows=(await db.query(`SELECT ${columns}
      FROM node_market_raw_logs l JOIN node_markets m ON m.id=l.market_id
      LEFT JOIN LATERAL(SELECT 1 AS selected FROM node_market_history_jobs j WHERE j.token_address=m.token_address AND j.expires_at>now()
        AND l.timestamp BETWEEN j.from_at AND j.to_at LIMIT 1) requested ON true WHERE (l.decode_status IN ('pending','missing_quote')
        OR l.decode_status='unsupported' AND l.decoder_version<$2 AND l.log->'topics'->>0=ANY($3::text[]))
      AND ($4::bigint IS NULL OR l.block_number>=$4 OR $5::boolean AND EXISTS(SELECT 1 FROM node_market_token_evidence p
        WHERE p.token_address=m.token0 AND p.block_hash=l.block_hash) AND EXISTS(SELECT 1 FROM node_market_token_evidence p
        WHERE p.token_address=m.token1 AND p.block_hash=l.block_hash))
      AND m.status<>'unsupported' AND ${eligible} ORDER BY
        CASE WHEN $4::bigint IS NOT NULL AND l.decode_status='missing_quote' AND l.block_number<$4 THEN 1 ELSE 0 END,
        requested.selected DESC NULLS LAST,
        CASE WHEN l.decode_status='pending' THEN 0 ELSE 1 END,
        CASE WHEN requested.selected IS NOT NULL THEN l.block_number END ASC,
        l.block_number DESC,l.transaction_index,l.log_index LIMIT $1`,
    [cap,nodeMarketDecoderVersion,protocolMarketTopics,options.minimumBlock??null,!!options.allowCapturedOlder])).rows;
    // Query wait is measured separately from bounded decoding work. A slow
    // selection must not reduce every cycle to a single row indefinitely.
    const began=performance.now(),selectionMs=began-cycleBegan;let decoded = 0,examined=0;const examinedKeys=new Set<string>();
    for (const row of selectedRows) {
      if(examined>0&&options.maxDurationMs!==undefined&&performance.now()-began>=options.maxDurationMs)break;
      examined++;
      if(Number.isInteger(row.decode_next_lane))nextLane=row.decode_next_lane;
      if(Number.isInteger(row.decode_next_recovery_lane))nextRecoveryLane=row.decode_next_recovery_lane;
      const log = row.raw_log as NodeMarketLog, market = identity(row), checkpoint = { blockNumber:Number(row.observed_block),blockHash:row.observed_hash,timestamp:dateText(row.observed_at) };
      const persistedOnly=!!options.databaseOnly||options.minimumBlock!==undefined&&checkpoint.blockNumber<options.minimumBlock;
      // Unrelated controller/pool events need no financial RPC. Only structurally
      // supported movements proceed to strict block-specific precision checks.
      let status='unsupported';
      if(decodeNodeMarketLog(market,log)) {
        const [meta0,meta1]=await Promise.all([metadata(market.token0,checkpoint,persistedOnly),metadata(market.token1,checkpoint,persistedOnly)]);
        if(meta0&&meta1){market.decimals0=meta0.decimals;market.decimals1=meta1.decimals;}
        const observation=meta0&&meta1?decodeNodeMarketLog(market,log):null;
        status=!meta0||!meta1?'missing_quote':!observation?'unsupported':await storeObservation(market,checkpoint,{id:`${market.id}:${checkpoint.blockHash}:${log.transactionHash.toLowerCase()}:${Number(BigInt(log.logIndex))}`,
          kind:observation.swap?'swap':'state',priceQuote:observation.priceQuote,tokenAmountRaw:observation.tokenAmountRaw,quoteAmountRaw:observation.quoteAmountRaw,log},persistedOnly)?'decoded':'missing_quote';
      }
      await db.query('UPDATE node_market_raw_logs SET decode_status=$1,decoder_version=$6 WHERE market_id=$2 AND block_hash=$3 AND tx_hash=$4 AND log_index=$5',
        [status,market.id,checkpoint.blockHash,log.transactionHash.toLowerCase(),Number(BigInt(log.logIndex)),nodeMarketDecoderVersion]);
      examinedKeys.add(recoveryKey(row));
      if (status === 'decoded') decoded++;
    }
    const decodingMs=performance.now()-began;
    if(persistedProgress){
      const cursors:Record<string,DecodeCursor|null|number>={nextLane,nextRecoveryLane};
      for(const cohort of recovery){
        let cursor=cohort.keys.length?cohort.previous:null;
        for(const row of cohort.keys){
          if(cohort.eligible.has(recoveryKey(row))&&!examinedKeys.has(recoveryKey(row)))break;
          cursor={block:row.block_number,transactionIndex:row.transaction_index,logIndex:row.log_index,market:row.market_id,transaction:row.tx_hash,hash:row.block_hash};
        }
        cursors[cohort.status]=cursor;
      }
      await db.query(`INSERT INTO worker_state(key,value,updated_at)VALUES('node_market_decode_recovery',$1::jsonb,now())
        ON CONFLICT(key)DO UPDATE SET value=worker_state.value||EXCLUDED.value,updated_at=EXCLUDED.updated_at`,[JSON.stringify(cursors)]);
    }
    // A durable pending flag makes candle projection resumable even if the
    // process stops after decoding but before the candle commit.
    const projectionBegan=performance.now();
    const pending=await db.query(`SELECT token_address,min(timestamp) AS from_at,max(timestamp) AS to_at,array_agg(id) AS ids
      FROM (SELECT id,token_address,timestamp FROM node_market_observations WHERE kind='swap' AND candles_pending ORDER BY timestamp LIMIT 3000) p GROUP BY token_address`);
    for(const row of pending.rows) {
      const client=await db.connect();
      try {await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(908335)');
        await rebuildCandles(client,row.token_address,dateText(row.from_at),dateText(row.to_at));
        await client.query('UPDATE node_market_observations SET candles_pending=false WHERE id=ANY($1::text[])',[row.ids]);await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    }
    return { examined,decoded,timings:{selected:selectedRows.length,selectionMs:Math.round(selectionMs),decodingMs:Math.round(decodingMs),
      projectionMs:Math.round(performance.now()-projectionBegan),totalMs:Math.round(performance.now()-cycleBegan)} };
  }
  async function collectRange(from: number, to: number, options: { marketIds?: string[]; liveCheckpoint?: boolean } = {}) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from<0 || to<from || to-from>=MAX_RANGE) throw new Error('market_range_too_large');
    const eligible=await eligibleTargetSql('m.token_address');
    const rows=await db.query(`SELECT m.* FROM node_markets m WHERE status IN ('active','graduated','unsupported','repair')
      AND ${eligible} AND ($1::text[] IS NULL OR id=ANY($1::text[]))`,[options.marketIds ?? null]);
    if (!rows.rows.length) return { markets:0,logs:0 };
    const contracts=[...new Set<string>(rows.rows.map(row=>row.contract_address))], logs:NodeMarketLog[]=[];
    for(let offset=0;offset<contracts.length;offset+=40) logs.push(...await rpc<NodeMarketLog[]>('eth_getLogs',[
      {fromBlock:blockHex(from),toBlock:blockHex(to),address:contracts.slice(offset,offset+40)}]));
    // The block cache is range-local; canonical headers must be reread after a
    // reorg rather than trusting a process lifetime block-number cache.
    blockJobs.clearCompleted();
    const headers=new Map<number,NodeMarketBlock>();
    const support=(await db.query(`SELECT to_regclass('public.node_evidence_blocks') IS NOT NULL AS available,
      to_regclass('public.node_evidence_metadata_jobs') IS NOT NULL AS metadata_queue,
      to_regclass('public.tokens') IS NOT NULL AS token_metadata`)).rows[0];
    const hasEvidence=support?.available;let capturedLast=false;
    if(hasEvidence) {
      const saved=await db.query('SELECT block_number::text,block_hash,parent_hash,timestamp FROM node_evidence_blocks WHERE block_number BETWEEN $1 AND $2',[from,to]);
      capturedLast=saved.rows.some(row=>Number(row.block_number)===to);
      for(const row of saved.rows) {const height=Number(row.block_number),header={blockNumber:height,blockHash:hash(row.block_hash),parentHash:hash(row.parent_hash),timestamp:dateText(row.timestamp)};
        headers.set(height,header);blockJobs.set(height,Promise.resolve(header));}
    }
    for(let offset=from;offset<=to;offset+=8) await Promise.all(Array.from({length:Math.min(8,to-offset+1)},(_,i)=>offset+i).map(async height=>{if(!headers.has(height))headers.set(height,await block(height));}));
    const first=headers.get(from)!,last=headers.get(to)!;
    for(let height=from+1;height<=to;height++)if(headers.get(height)!.parentHash!==headers.get(height-1)!.blockHash)throw new Error('market_parent_mismatch');
    for(const log of logs) {
      const header=headers.get(Number(BigInt(log.blockNumber)));if(!header)throw new Error('market_log_outside_range');
      if(log.removed || hash(log.blockHash)!==header.blockHash || !/^0x[0-9a-f]+$/i.test(log.transactionIndex) || !/^0x[0-9a-f]+$/i.test(log.logIndex)) throw new Error('market_log_block_mismatch');
      hash(log.transactionHash);
    }
    // Prepare parameter records before taking collection/rollback locks. One
    // controller may serve many registered tokens, but each genuine identified
    // event keeps the same per-market execution identity as the scalar path.
    const logsByContract=new Map<string,NodeMarketLog[]>();
    for(const log of logs){const key=log.address.toLowerCase();if(!logsByContract.has(key))logsByContract.set(key,[]);logsByContract.get(key)!.push(log);}
    const controllerTokens=new Map<string,Set<string>>();
    for(const row of rows.rows)if(['fourmeme','flap'].includes(row.protocol)){
      const tokens=controllerTokens.get(row.contract_address)??new Set<string>();tokens.add(row.token_address);controllerTokens.set(row.contract_address,tokens);
    }
    const controllerLogs=new Map<string,Map<string,NodeMarketLog[]>>();
    for(const [contract,tokens]of controllerTokens){controllerLogs.set(contract,indexNodeControllerLogs(tokens,logsByContract.get(contract)??[]));await yieldEventLoop();}
    const rawRows:{market_id:string;block_number:number;block_hash:string;tx_hash:string;transaction_index:number;log_index:number;timestamp:string;log:NodeMarketLog}[]=[];
    const tokenMetadata=support?.token_metadata?(await db.query('SELECT address,symbol,name FROM tokens WHERE address=ANY($1::text[])',
      [[...new Set(rows.rows.map(row=>row.token_address))]])).rows:[];
    const knownTokens=new Map(tokenMetadata.map(row=>[row.address,row]));
    const metadataBlocks=new Map<string,{blockNumber:number;blockHash:string;timestamp:string;tokens:Set<string>;observedLive:boolean}>();
    let decodeCandidates=0;
    for(const row of rows.rows) {
      const market=identity(row);
      const candidates=['fourmeme','flap'].includes(market.protocol)?controllerLogs.get(market.contract)?.get(market.token)??[]:logsByContract.get(market.contract)??[];
      for(const log of candidates) {
        if(market.poolId&&log.topics[1]?.toLowerCase()!==market.poolId)continue;
        if(++decodeCandidates%128===0)await yieldEventLoop();
        const observation=decodeNodeMarketLog(market,log);
        const header=headers.get(Number(BigInt(log.blockNumber)))!;
        if(observation&&isKolProfileToken(knownTokens.get(market.token)??{address:market.token})) {
          const entry=metadataBlocks.get(header.blockHash)??{blockNumber:header.blockNumber,blockHash:header.blockHash,
            timestamp:header.timestamp,tokens:new Set<string>(),observedLive:!!options.liveCheckpoint};
          entry.tokens.add(market.token);entry.tokens.add(market.quote);metadataBlocks.set(header.blockHash,entry);
        }
        rawRows.push({market_id:market.id,block_number:header.blockNumber,block_hash:header.blockHash,tx_hash:log.transactionHash.toLowerCase(),
          transaction_index:Number(BigInt(log.transactionIndex)),log_index:Number(BigInt(log.logIndex)),timestamp:header.timestamp,log});
      }
    }
    const marketIds=rows.rows.map(row=>row.id);
    const external=!capturedLast?await rpc<{number:string;hash:string;timestamp:string}>('eth_getBlockByNumber',[blockHex(to),false]):null;
    if(external&&(Number(BigInt(external.number))!==to||hash(external.hash)!==last.blockHash
      ||Number(BigInt(external.timestamp))*1000!==Date.parse(last.timestamp)))throw new Error('market_canonical_checkpoint_changed');
    if(!capturedLast&&!external)throw new Error('market_canonical_checkpoint_unavailable');
    const client=await db.connect();
    try {
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock_shared(782319)'); await client.query('SELECT pg_advisory_xact_lock(908335)');
      const captured=hasEvidence?(await client.query('SELECT block_hash,timestamp FROM node_evidence_blocks WHERE block_number=$1',[to])).rows[0]:null;
      if(captured){
        if(hash(captured.block_hash)!==last.blockHash||Date.parse(dateText(captured.timestamp))!==Date.parse(last.timestamp))throw new Error('market_canonical_checkpoint_changed');
      }else if(capturedLast||!external)throw new Error('market_canonical_checkpoint_unavailable');
      for(let offset=0;offset<rawRows.length;offset+=500)await client.query(`INSERT INTO node_market_raw_logs
        (market_id,block_number,block_hash,tx_hash,transaction_index,log_index,timestamp,log,decode_status)
        SELECT r.market_id,r.block_number,r.block_hash,r.tx_hash,r.transaction_index,r.log_index,r.timestamp,r.log,'pending'
        FROM jsonb_to_recordset($1::jsonb) AS r(market_id text,block_number bigint,block_hash text,tx_hash text,
          transaction_index integer,log_index integer,timestamp timestamptz,log jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(rawRows.slice(offset,offset+500))]);
      // Unrelated participants' swaps and genuine pool-state events need the same prompt financial proofs as
      // watched executions. Queue database-only work atomically with raw logs;
      // the independent urgent drain captures exact state before it is pruned.
      if(hasEvidence&&support.metadata_queue&&metadataBlocks.size)await enqueueNodeEvidenceMetadataCheckpoints(client,
        [...metadataBlocks.values()].map(entry=>({...entry,tokens:[...entry.tokens]})));
      await client.query(`INSERT INTO node_market_ranges(market_id,from_block,to_block,from_hash,to_hash,from_at,to_at,complete)
        SELECT unnest($1::text[]),$2::bigint,$3::bigint,$4,$5,$6::timestamptz,$7::timestamptz,true
        ON CONFLICT(market_id,from_block,to_block) DO UPDATE SET from_hash=EXCLUDED.from_hash,to_hash=EXCLUDED.to_hash,
          from_at=EXCLUDED.from_at,to_at=EXCLUDED.to_at,complete=true`,[marketIds,from,to,first.blockHash,last.blockHash,first.timestamp,last.timestamp]);
      await client.query(`UPDATE node_markets SET collected_from_block=LEAST(COALESCE(collected_from_block,$2),$2),
        collected_through_block=GREATEST(COALESCE(collected_through_block,$3),$3),last_error=NULL WHERE id=ANY($1::text[])`,[marketIds,from,to]);
      if(options.liveCheckpoint)await client.query(`INSERT INTO worker_state(key,value) VALUES('node_market_collection',$1::jsonb)
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
        WHERE COALESCE((worker_state.value->>'blockNumber')::bigint,-1)<=$2`,
      [JSON.stringify({blockNumber:to,blockHash:last.blockHash,at:new Date(now()).toISOString(),markets:rows.rows.length,logs:logs.length}),to]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return {markets:rows.rows.length,logs:logs.length,decodeCandidates};
  }
  async function refreshState(row: any, checkpoint: NodeMarketBlock) {
    const market=identity(row), tokenIs0=market.token0===market.token; let priceQuote:string|null=null;
    try {
      const [meta0,meta1]=await Promise.all([metadata(market.token0,checkpoint),metadata(market.token1,checkpoint)]);
      if(!meta0||!meta1)throw new Error('market_metadata_unavailable');market.decimals0=meta0.decimals;market.decimals1=meta1.decimals;
      if(market.protocol==='pcs_v2') { const result=await call(market.contract,poolMarketAbi,'getReserves',[],checkpoint.blockNumber);
        priceQuote=ratioPrice(BigInt(tokenIs0?result.reserve1:result.reserve0),BigInt(tokenIs0?result.reserve0:result.reserve1),tokenIs0?market.decimals1:market.decimals0,tokenIs0?market.decimals0:market.decimals1); }
      else if(market.protocol==='pcs_v3') { const result=await call(market.contract,poolMarketAbi,'slot0',[],checkpoint.blockNumber); priceQuote=sqrtPrice(BigInt(result.sqrtPriceX96),tokenIs0,market.decimals0,market.decimals1); }
      else if(market.protocol==='infinity_cl') { const result=await call(market.contract,infinityMarketAbi,'getSlot0',[market.poolId],checkpoint.blockNumber); priceQuote=sqrtPrice(BigInt(result.sqrtPriceX96),tokenIs0,market.decimals0,market.decimals1); }
      else if(market.protocol==='infinity_bin') { const result=await call(market.contract,infinityBinMarketAbi,'getSlot0',[market.poolId],checkpoint.blockNumber); priceQuote=binPrice(Number(result.activeId),String(market.authentication.parameters),tokenIs0,market.decimals0,market.decimals1); }
      else if(market.protocol==='fourmeme') { const info=await call(FOUR_HELPER,fourInterface,'getTokenInfo',[market.token],checkpoint.blockNumber);
        if(String(info.tokenManager).toLowerCase()!==market.contract || ![1n,2n].includes(BigInt(info.version))) throw new Error('unsupported_market_version');
        if(info.liquidityAdded) { await db.query("UPDATE node_markets SET status='graduated' WHERE id=$1",[market.id]); return; }
        if(market.decimals0===18) priceQuote=MarketDecimal.raw(BigInt(info.lastPrice),market.decimals1).text(); }
      else { const method=String(market.authentication.method) as 'getTokenV8Safe'|'getTokenV7';
        const info=(await call(FLAP_PORTAL,flapInterface,method,[market.token],checkpoint.blockNumber))[0];
        if(BigInt(info.status)===4n) { await db.query("UPDATE node_markets SET status='graduated' WHERE id=$1",[market.id]); return; }
        if(BigInt(info.status)!==1n || market.decimals0!==18) throw new Error('unsupported_market_version');
        priceQuote=MarketDecimal.raw(BigInt(info.price),18).text(); }
      if(!priceQuote||!positiveDecimal(priceQuote))throw new Error('state_unavailable');
      if(!await storeObservation(market,checkpoint,{id:`state:${market.id}:${checkpoint.blockHash}`,kind:'state',priceQuote}))throw new Error('quote_unavailable');
      await db.query('UPDATE node_markets SET checked_at=$2,last_error=NULL WHERE id=$1',[market.id,checkpoint.timestamp]);
    } catch(error) { await db.query('UPDATE node_markets SET checked_at=$2,last_error=$3,retry_at=$2::timestamptz+interval \'30 seconds\' WHERE id=$1',
      [market.id,checkpoint.timestamp,error instanceof Error && error.message==='unsupported_market_version'?'unsupported_decoder':error instanceof Error&&error.message==='quote_unavailable'?'quote_unavailable':'state_unavailable']); }
  }
  async function historyWindowTick(checkpoint:NodeMarketBlock,retainedBlocks:number) {
    const eligible=await eligibleTargetSql('j.token_address');
    const lease=randomUUID(),job=(await db.query(`UPDATE node_market_history_jobs SET lease_id=$1,lease_until=now()+interval '90 seconds'
      WHERE (token_address,window_id) IN(SELECT token_address,window_id FROM node_market_history_jobs j
        WHERE completed_at IS NULL AND expires_at>now() AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now())
        AND ${eligible}
        ORDER BY priority DESC,requested_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,[lease])).rows[0];
    if(!job)return false;
    try {
      const markets=(await db.query("SELECT id FROM node_markets WHERE token_address=$1 AND status IN ('active','graduated','repair')",[job.token_address])).rows;
      if(!markets.length)throw new Error('history_market_pending');
      const fromTime=Date.parse(dateText(job.from_at)),toTime=Date.parse(dateText(job.to_at));
      if(toTime>Date.parse(checkpoint.timestamp))throw new Error('history_checkpoint_pending');
      let from=job.next_block==null?null:Number(job.next_block),end=job.end_block==null?null:Number(job.end_block);
      if(from===null||end===null) {
        const floor=Math.max(0,checkpoint.blockNumber-retainedBlocks+100),oldest=await block(floor);
        if(fromTime<Date.parse(oldest.timestamp))throw new Error('pruned_market_range');
        const hasHeaders=(await db.query("SELECT to_regclass('node_evidence_blocks') IS NOT NULL AS yes")).rows[0]?.yes;
        const bounds=hasHeaders?(await db.query(`SELECT
          (SELECT block_number::text FROM node_evidence_blocks WHERE timestamp<$1 ORDER BY timestamp DESC,block_number DESC LIMIT 1) AS before,
          (SELECT block_number::text FROM node_evidence_blocks WHERE timestamp>$2 ORDER BY timestamp,block_number LIMIT 1) AS after`,[job.from_at,job.to_at])).rows[0]:{};
        const lowerBound=async(time:number)=>{let low=floor,high=checkpoint.blockNumber;
          while(low<high){const middle=Math.floor((low+high)/2),header=await block(middle);if(Date.parse(header.timestamp)<time)low=middle+1;else high=middle;}return low;};
        from=bounds.before==null?Math.max(floor,(await lowerBound(fromTime))-1):Math.max(floor,Number(bounds.before));
        end=bounds.after==null?Math.min(checkpoint.blockNumber,await lowerBound(toTime+1)):Math.min(checkpoint.blockNumber,Number(bounds.after));
        await db.query('UPDATE node_market_history_jobs SET next_block=$3,end_block=$4 WHERE token_address=$1 AND window_id=$2 AND lease_id=$5',[job.token_address,job.window_id,from,end,lease]);
      }
      const to=Math.min(end,from+MAX_RANGE-1);
      if(from<=to)await collectRange(from,to,{marketIds:markets.map(row=>row.id)});
      await db.query(`UPDATE node_market_history_jobs SET next_block=$3::bigint,completed_at=CASE WHEN $3::bigint>$4::bigint THEN now() ELSE NULL END,
        lease_id=NULL,lease_until=NULL,last_error=NULL,next_attempt_at=now() WHERE token_address=$1 AND window_id=$2 AND lease_id=$5`,
      [job.token_address,job.window_id,to+1,end,lease]);
      return true;
    }catch(error){const reason=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'history_collection_retry';
      await db.query(`UPDATE node_market_history_jobs SET lease_id=NULL,lease_until=NULL,last_error=$3,next_attempt_at=now()+interval '10 seconds'
        WHERE token_address=$1 AND window_id=$2 AND lease_id=$4`,[job.token_address,job.window_id,reason,lease]);return false;}
  }
  async function tick(input: { confirmedBlock: number; maxMarkets?: number; retainedBlocks?: number; priorityTokens?: string[];deferHistoricalBackfill?:boolean;refreshStateHead?:boolean;skipDecoding?:boolean }) {
    blockJobs.clearCompleted();
    const start=now(),began=performance.now(), maxMarkets=Math.min(100,Math.max(1,input.maxMarkets??12));
    const freshCheckpoint=async()=>{const head=Number(BigInt(await rpc<string>('eth_blockNumber',[])));return block(Math.max(0,head-6));};
    let checkpoint=input.refreshStateHead?await freshCheckpoint():await block(input.confirmedBlock);
    // Capture the trusted conversions at the live checkpoint before slow market
    // backfills. Fees remain priceable even with no recent watched-token swap.
    const feedResults=await Promise.allSettled(Object.keys(TRUSTED_QUOTE_FEEDS).map(quote=>feedPrice(quote,checkpoint)));
    const unavailableFeeds=feedResults.filter(result=>result.status==='rejected'||result.value===null).length;
    await db.query('DELETE FROM node_market_refresh_jobs WHERE expires_at<=now()');
    const foreground=(await db.query('SELECT token_address FROM node_market_refresh_jobs WHERE expires_at>now() ORDER BY priority DESC,requested_at LIMIT 100')).rows;
    const priorityTokens=[...new Set([...foreground.map(row=>row.token_address),...(input.priorityTokens??[])].filter(token=>/^0x[0-9a-fA-F]{40}$/.test(token)).map(token=>token.toLowerCase()))].slice(0,100);
    const eligible=await eligibleTargetSql('m.token_address');
    const selected=await db.query(`SELECT m.* FROM node_markets m WHERE status='active' AND ${eligible} AND (retry_at IS NULL OR retry_at<=now())
      ORDER BY CASE WHEN token_address=ANY($2::text[]) AND (checked_at IS NULL OR checked_at<$3::timestamptz-interval '15 seconds') THEN 0 ELSE 1 END,
        CASE WHEN checked_at IS NULL OR checked_at<$3::timestamptz-interval '15 seconds' THEN array_position($2::text[],token_address) END ASC NULLS LAST,
        checked_at ASC NULLS FIRST,id LIMIT $1`,[maxMarkets,priorityTokens,checkpoint.timestamp]);
    let refreshedMarkets=0;
    for(const row of selected.rows) {
      if(refreshedMarkets>0&&performance.now()-began>8000)break;
      // Discovery and one-hop conversion can outlast a full node's state
      // retention window. Each mark stays bound to a genuine recent confirmed
      // hash; a long batch never keeps reusing its original pruned state tag.
      if(input.refreshStateHead&&now()-Date.parse(checkpoint.timestamp)>15000)checkpoint=await freshCheckpoint();
      await refreshState(row,checkpoint);
      refreshedMarkets++;
      await db.query(`DELETE FROM node_market_refresh_jobs j WHERE j.token_address=$1 AND EXISTS(
        SELECT 1 FROM node_market_observations o WHERE o.token_address=j.token_address AND o.source='node'
          AND o.block_number>=$2 AND o.timestamp>now()-interval '3 minutes')`,[row.token_address,checkpoint.blockNumber]);
    }
    // Bound backfill independently of live collection. Every completed page is
    // durable; a pruned range is a gap, never silently a successful checkpoint.
    const repairedWindow=await historyWindowTick(checkpoint,input.retainedBlocks??600000);
    const repairs=await db.query(`SELECT m.* FROM node_markets m WHERE status IN ('active','graduated') AND ${eligible} AND (NOT collection_gap OR token_address=ANY($2::text[]))
      AND (retry_at IS NULL OR retry_at<=now())
      ORDER BY CASE WHEN token_address=ANY($2::text[]) THEN 0 ELSE 1 END,array_position($2::text[],token_address) NULLS LAST,
        backfill_next_block ASC NULLS FIRST,id LIMIT $1`,[input.deferHistoricalBackfill?0:Math.max(0,Math.min(maxMarkets,4)-(repairedWindow?1:0)),priorityTokens]);
    for(const row of repairs.rows) {
      if(performance.now()-began>12000)break;
      const floor=Math.max(0,input.confirmedBlock-(input.retainedBlocks??600000)+100);
      if(priorityTokens.includes(row.token_address)) {
        // A newly selected market can be discovered after the live collector
        // has passed its first swap. Use the existing one-page repair budget
        // for the nearest genuine gap first; old pages and the independent
        // forward cursor remain intact. Repeated ticks resume backwards.
        let recentTo=input.confirmedBlock;
        const completed=await db.query(`SELECT r.from_block::text,r.to_block::text FROM node_market_ranges r WHERE market_id=$1
          AND complete AND to_block>=$2 AND from_block<=$3 ORDER BY r.to_block DESC,r.from_block DESC`,[row.id,floor,input.confirmedBlock]);
        for(const range of completed.rows) {
          const a=Number(range.from_block),b=Number(range.to_block);
          if(a>recentTo)continue;if(b<recentTo)break;recentTo=a-1;
        }
        if(recentTo>=floor) {
          try {await collectRange(Math.max(floor,recentTo-MAX_RANGE+1),recentTo,{marketIds:[row.id]});}
          catch {await db.query("UPDATE node_markets SET last_error='market_collection_retry',retry_at=now()+interval '30 seconds' WHERE id=$1",[row.id]);}
          continue;
        }
      }
      const from=row.backfill_next_block==null?floor:Number(row.backfill_next_block);
      if(from>input.confirmedBlock) continue;
      if(from<floor) { await db.query("UPDATE node_markets SET collection_gap=true,last_error='pruned_market_range' WHERE id=$1",[row.id]); continue; }
      try { const to=Math.min(from+MAX_RANGE-1,input.confirmedBlock);await collectRange(from,to,{marketIds:[row.id]});
        await db.query(`UPDATE node_markets SET backfill_next_block=GREATEST(COALESCE(backfill_next_block,0),$2),
          backfill_floor_block=COALESCE(backfill_floor_block,$3) WHERE id=$1`,[row.id,to+1,from]); }
      catch { await db.query("UPDATE node_markets SET last_error='market_collection_retry',retry_at=now()+interval '30 seconds' WHERE id=$1",[row.id]); }
    }
    const decoded=input.skipDecoding?{examined:0,decoded:0}:await decodePending(input.deferHistoricalBackfill?4:300,{minimumBlock:checkpoint.blockNumber-(input.deferHistoricalBackfill?64:128),
      allowCapturedOlder:!input.deferHistoricalBackfill,maxDurationMs:1500});
    return {markets:refreshedMarkets,unavailableFeeds,repairedWindow,historicalBackfillDeferred:!!input.deferHistoricalBackfill,
      quoteBlock:checkpoint.blockNumber,quoteAsOf:checkpoint.timestamp,...decoded,durationMs:now()-start};
  }
  async function importObservations(input:NodeMarketImport) {
    const token=address(input.token), from=iso(input.from),to=iso(input.to);
    if(!input.importId || input.importId.length>200 || Date.parse(to)<Date.parse(from) || input.observations.length>5000) throw new Error('invalid_market_import');
    const rows=input.observations.map((row,index)=> {
      const timestamp=iso(row.timestamp), values=[row.open??row.priceUsd,row.high??row.priceUsd,row.low??row.priceUsd,row.close??row.priceUsd];
      if(Date.parse(timestamp)<Date.parse(from) || Date.parse(timestamp)>Date.parse(to) || !positiveDecimal(row.priceUsd) || !values.every(positiveDecimal)) throw new Error('invalid_market_import_observation');
      const [open,high,low,close]=values.map(MarketDecimal.parse);
      if(high.compare(open)<0 || high.compare(close)<0 || low.compare(open)>0 || low.compare(close)>0 || low.compare(high)>0) throw new Error('invalid_imported_candle');
      if(row.volumeUsd!=null && MarketDecimal.parse(row.volumeUsd).n<0n || row.supply!=null && MarketDecimal.parse(row.supply).n<0n) throw new Error('invalid_market_import_quantity');
      if(row.intervalSeconds!=null && (!Number.isInteger(row.intervalSeconds)||row.intervalSeconds<0||row.intervalSeconds>86400)) throw new Error('invalid_chart_interval');
      return {...row,timestamp,index,values};
    });
    const client=await db.connect();
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(908335)');
      for(const row of rows) await client.query(`INSERT INTO node_market_observations(id,token_address,kind,source,timestamp,price_usd,volume_usd,supply,supply_estimated,interval_seconds,open,high,low,close,import_id)
        VALUES($1,$2,'imported','imported',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
      [`import:${input.importId}:${token}:${row.timestamp}:${row.intervalSeconds??0}`,token,row.timestamp,row.priceUsd,row.volumeUsd??null,row.supply??null,row.supply==null,row.intervalSeconds??0,...row.values,input.importId]);
      await client.query(`INSERT INTO node_market_import_ranges(token_address,import_id,from_at,to_at,complete) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(token_address,import_id,from_at,to_at) DO UPDATE SET complete=node_market_import_ranges.complete OR EXCLUDED.complete`,[token,input.importId,from,to,input.complete]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally {client.release();}
  }
  return {captureMetadata:async(tokens:string[],checkpoint:NodeMarketBlock)=>{
      const selected=[...new Set(tokens.map(address))].slice(0,20);
      const results=await Promise.allSettled(selected.map(token=>metadata(token,checkpoint)));
      const capturedTokens=selected.filter((_,index)=>results[index].status==='fulfilled'&&results[index].value!==null);
      return {requested:selected.length,captured:capturedTokens.length,capturedTokens};
    },captureFeedEvidence:async(checkpoint:NodeMarketBlock,tokens:string[]=[],options:{conversions?:boolean}={})=>{
      const results=await Promise.allSettled(Object.keys(TRUSTED_QUOTE_FEEDS).map(quote=>feedPrice(quote,checkpoint)));
      const rows=(await db.query('SELECT quote_address,feed_address,feed_description FROM node_market_feed_evidence WHERE block_hash=$1',[checkpoint.blockHash])).rows;
      const captured=rows.filter(row=>TRUSTED_QUOTE_FEEDS[row.quote_address]?.feed===row.feed_address&&TRUSTED_QUOTE_FEEDS[row.quote_address]?.description===row.feed_description).length;
      // Urgent precision work can preserve exact pinned oracle rounds before
      // optional pool-route discovery occupies the independent feed stage.
      // This partial result never authorizes completion of quote dependencies.
      if(options.conversions===false)return{requested:results.length,captured,quoteRequested:0,quoteCaptured:0,capturedQuoteTokens:[] as string[],unresolvedTokens:[] as string[]};
      const targets=[...new Set(tokens.map(address))].slice(0,20);
      const registered=targets.length?(await db.query(`SELECT DISTINCT token_address,quote_address FROM node_markets
        WHERE token_address=ANY($1::text[]) AND status IN ('active','graduated')
        UNION SELECT DISTINCT NULL::text,quote_address FROM node_markets
        WHERE quote_address=ANY($1::text[]) AND status IN ('active','graduated')`,[targets])).rows:[];
      const quotes=[...new Set(registered.map(row=>row.quote_address as string))];
      const knownTargets=new Set(registered.map(row=>row.token_address));
      // Metadata jobs contain both sides of an authenticated market. A quote
      // dependency need not be a tracked market target itself; its exact proof
      // below still has to succeed before this job can complete.
      const knownQuotes=new Set(quotes);
      const unresolvedTokens=targets.filter(token=>!knownTargets.has(token)&&!knownQuotes.has(token)&&!TRUSTED_QUOTE_FEEDS[token]);
      const exactQuotes=async()=>quotes.length?(await db.query(`SELECT p.token_address FROM node_market_token_evidence p
        WHERE p.token_address=ANY($1::text[]) AND p.block_hash=$2 AND (EXISTS(SELECT 1 FROM node_market_feed_evidence f
          WHERE f.quote_address=p.token_address AND f.block_hash=p.block_hash AND f.feed_address=($3::jsonb->p.token_address->>'feed')
            AND f.feed_description=($3::jsonb->p.token_address->>'description'))
          OR EXISTS(SELECT 1 FROM node_market_quote_evidence q WHERE q.quote_address=p.token_address AND q.block_hash=p.block_hash AND q.schema_version=1))`,
      [quotes,checkpoint.blockHash,JSON.stringify(TRUSTED_QUOTE_FEEDS)])).rows.map(row=>row.token_address as string):[];
      const completed=new Set(await exactQuotes());
      // Preserve conversion state and quote precision before the full node
      // prunes it. Four missing routes per pass bound this urgent node work;
      // completed exact-block proofs let retries continue with the remainder.
      await Promise.allSettled(quotes.filter(quote=>!completed.has(quote)).slice(0,4).map(async quote=>{
        await Promise.all([metadata(quote,checkpoint),feedPrice(quote,checkpoint)]);
      }));
      const capturedQuoteTokens=await exactQuotes();
      return {requested:results.length+quotes.length+unresolvedTokens.length,captured:captured+capturedQuoteTokens.length,
        quoteRequested:quotes.length,quoteCaptured:capturedQuoteTokens.length,capturedQuoteTokens,unresolvedTokens};
    },requestHistoryWindow:async(token:string,from:string,to:string,options:{snapshotId?:string;windowId?:string;priority?:number}={})=>{
      const selected=address(token),first=iso(from),last=iso(to);
      if(Date.parse(last)<Date.parse(first)||options.snapshotId&&options.snapshotId.length>200||options.windowId&&options.windowId.length>200)throw new Error('invalid_history_window');
      const windowId=options.windowId??createHash('sha256').update([selected,first,last].join(':')).digest('hex');
      const requested=await db.query(`INSERT INTO node_market_history_jobs(token_address,window_id,snapshot_id,from_at,to_at,expires_at,priority)
        VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes',$6)
        ON CONFLICT(token_address,window_id) DO UPDATE SET expires_at=GREATEST(node_market_history_jobs.expires_at,EXCLUDED.expires_at)
        WHERE node_market_history_jobs.from_at=EXCLUDED.from_at AND node_market_history_jobs.to_at=EXCLUDED.to_at RETURNING window_id`,
      [selected,windowId,options.snapshotId??null,first,last,Math.min(10,Math.max(1,Math.floor(options.priority??10)))]);
      if(!requested.rows.length)throw new Error('history_window_binding_mismatch');
      await db.query(`INSERT INTO node_market_refresh_jobs(token_address,priority,expires_at) VALUES($1,10,now()+interval '2 minutes')
        ON CONFLICT(token_address) DO UPDATE SET priority=10,expires_at=GREATEST(node_market_refresh_jobs.expires_at,EXCLUDED.expires_at)`,[selected]);
      return {windowId};
    },requestRefresh:async(token:string,options:{priority?:number}={})=> {
      const selected=address(token),priority=Math.min(10,Math.max(1,Math.floor(options.priority??1)));
      await db.query(`INSERT INTO node_market_refresh_jobs(token_address,priority,requested_at,expires_at) VALUES($1,$2,now(),now()+interval '2 minutes')
        ON CONFLICT(token_address) DO UPDATE SET priority=GREATEST(node_market_refresh_jobs.priority,EXCLUDED.priority),
          expires_at=GREATEST(node_market_refresh_jobs.expires_at,EXCLUDED.expires_at)`,[selected,priority]);
    },quote:(token:string,opts:{maxAgeMs?:number}={})=>readNodeMarketQuote(db,token,{...opts,now:now()}),
    replaySamples:(token:string,opts:{from:string;to:string;limit?:number})=>readNodeMarketReplaySamples(db,token,opts),
    priceAt:(token:string,opts:{timestamp:string;blockNumber?:string;maxAgeMs?:number})=>readNodeMarketQuote(db,token,{...opts,now:now()}),
    chart:(token:string,opts:{from:string;to:string;intervalSeconds?:number;limit?:number})=>readNodeMarketChart(db,token,opts),
    discover,collectRange,decodePending,tick,importObservations,
    refreshState:async(marketId:string,checkpoint:NodeMarketBlock)=> {const row=(await db.query('SELECT * FROM node_markets WHERE id=$1',[marketId])).rows[0]; if(row) await refreshState(row,checkpoint);},
    rollback:async(database:DB,from:number)=> {blockJobs.clear();feedJobs.clear();metaJobs.clear();await rollbackNodeMarket(database,from);},
  };
}

/** Caller includes this in the same reorg transaction as canonical trade rollback. */
export async function rollbackNodeMarket(db:DB,from:number) {
  if(!Number.isSafeInteger(from)||from<0) throw new Error('invalid_market_reorg');
  await db.query('SELECT pg_advisory_xact_lock(908335)');
  // The live scan cursor belongs to the same transaction as its captured
  // ranges. Leaving it at the orphan height would skip replacement blocks.
  const hasWorkerState=(await db.query("SELECT to_regclass('worker_state') IS NOT NULL AS available")).rows[0]?.available;
  if(hasWorkerState) {
    if(from===0)await db.query("DELETE FROM worker_state WHERE key='node_market_collection'");
    else await db.query(`UPDATE worker_state SET value=jsonb_build_object('blockNumber',$1::bigint,'at',now(),'reason','chain_reorganization'),updated_at=now()
      WHERE key='node_market_collection' AND (value->>'blockNumber')::bigint>=$2`,[from-1,from]);
  }
  const affected=await db.query(`SELECT DISTINCT token_address,date_trunc('minute',timestamp) AS minute FROM node_market_observations WHERE source='node' AND block_number>=$1`,[from]);
  await db.query("DELETE FROM node_market_observations WHERE source='node' AND block_number>=$1",[from]);
  await db.query('DELETE FROM node_market_raw_logs WHERE block_number>=$1',[from]);
  await db.query('DELETE FROM node_market_feed_evidence WHERE block_number>=$1',[from]);
  await db.query('DELETE FROM node_market_quote_evidence WHERE block_number>=$1',[from]);
  await db.query(`UPDATE node_market_history_jobs SET next_block=NULL,end_block=NULL,completed_at=NULL,lease_id=NULL,lease_until=NULL,
    next_attempt_at=now(),last_error='chain_reorganization' WHERE end_block>=$1`,[from]);
  await db.query('DELETE FROM node_market_token_evidence WHERE block_number>=$1',[from]);
  await db.query('DELETE FROM node_market_ranges WHERE to_block>=$1',[from]);
  await db.query(`UPDATE node_markets SET collected_from_block=(SELECT min(from_block) FROM node_market_ranges r WHERE r.market_id=node_markets.id),
    collected_through_block=(SELECT max(to_block) FROM node_market_ranges r WHERE r.market_id=node_markets.id),checked_at=NULL,retry_at=NULL,
    backfill_next_block=LEAST(backfill_next_block,$1),
    status=CASE WHEN authenticated_at_block>=$1 THEN 'repair' ELSE status END WHERE collected_through_block>=$1 OR authenticated_at_block>=$1`,[from]);
  for(const row of affected.rows) {
    await db.query('DELETE FROM node_market_candles WHERE token_address=$1 AND minute=$2',[row.token_address,row.minute]);
    await db.query(`INSERT INTO node_market_candles(token_address,market_id,minute,open,high,low,close,volume_usd,observations,first_observation_at,last_observation_at)
      SELECT token_address,market_id,date_trunc('minute',timestamp),(array_agg(price_usd ORDER BY timestamp,block_number,transaction_index,log_index))[1],max(price_usd),min(price_usd),
        (array_agg(price_usd ORDER BY timestamp DESC,block_number DESC,transaction_index DESC,log_index DESC))[1],sum(COALESCE(volume_usd,0)),count(*),min(timestamp),max(timestamp)
      FROM node_market_observations WHERE token_address=$1 AND kind='swap' AND timestamp>=$2::timestamptz AND timestamp<$2::timestamptz+interval '1 minute'
      GROUP BY token_address,market_id,date_trunc('minute',timestamp)`,[row.token_address,row.minute]);
  }
}

export const nodeMarketService = createNodeMarketService({ db: pool, rpc: chainRpc });
