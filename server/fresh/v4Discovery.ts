import { createHash, randomUUID } from 'node:crypto';
import{AbiCoder,keccak256}from'ethers';
import type { Pool, PoolClient } from 'pg';
import { blockHex, type Rpc } from '../rpc.js';
import { FRESH_CONFIRMATIONS, freshAddress, freshHash, freshInteger, validateFreshBlock, validateFreshReceipt, type FreshBlock, type FreshLog, type FreshReceipt } from './capture.js';
import { authenticateFreshStockwavePoolInitialization, FRESH_UNISWAP_V4_BSC_MANAGER as manager, FRESH_UNISWAP_V4_INITIALIZE_TOPIC as topic,
  stockwavePoolManagerInterface, validFreshStockwaveMarketIdentity, type FreshStockwaveMarketIdentity } from './stockwaveMarket.js';
import{anchorFreshMarketInitialization,freshMarketIdentityInvalid}from'./currentMarketAnchor.js';
import{validFreshSupportedMarketIdentity,type FreshSupportedMarketIdentity}from'./currentMarketAnchor.js';
import{authenticateFreshInfinityClInitialization,FRESH_INFINITY_CL_INITIALIZE_TOPIC,freshInfinityClInterface}from'./infinityClMarket.js';
import{INFINITY_CL}from'../nodeMarketProtocols.js';
import{WBNB}from'../launchpad.js';

export const FRESH_V4_DISCOVERY_MAX_BLOCKS = 4_096;
export const FRESH_V4_DISCOVERY_MAX_RECEIPTS = 16;
export interface FreshV4DiscoveryProgress { version: 1; marketProtocolsVersion?:2;launchDigest: string; captureRevision: string; throughBlock: number; throughHash: string | null; rangeSize: number }
interface Header { number: number; hash: string; parentHash: string; timestamp: string }
interface UnsupportedPool{manager:string;poolId:string;blockNumber:number;blockHash:string;reason:'infinity_cl_pool_key_unsupported'}
export interface FreshV4DiscoveryPage { fromBlock: number; toBlock: number; identities: FreshSupportedMarketIdentity[]; headers: Header[]; receipts: number;unsupportedPools?:UnsupportedPool[] }
const canonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value)??'null':Array.isArray(value)?`[${value.map(canonical).join(',')}]`
  :`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const position = (log: FreshLog) => `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
const body = (log: FreshLog) => JSON.stringify([log.address.toLowerCase(), log.topics.map(value => value.toLowerCase()), log.data.toLowerCase()]);
const protocol=(identity:FreshSupportedMarketIdentity)=>identity.manager===INFINITY_CL?'infinity_cl':'uniswap_v4';
const marketId = (identity: FreshSupportedMarketIdentity) => `${protocol(identity)}:${identity.manager}:${identity.poolId}`;
const number = (value: string) => { const parsed = Number(freshInteger(value)); if (!Number.isSafeInteger(parsed)) throw Error('v4_discovery_number_invalid'); return parsed; };
const anchor = (value: unknown, expected: number): Header => {
  const block = value as FreshBlock;
  if (!block || number(block.number) !== expected || !freshHash(block.hash) || !freshHash(block.parentHash)) throw Error('v4_discovery_header_invalid');
  return { number: expected, hash: block.hash.toLowerCase(), parentHash: block.parentHash.toLowerCase(), timestamp: new Date(number(block.timestamp) * 1_000).toISOString() };
};
async function boundedMap<T, R>(values: T[], run: (value: T) => Promise<R>) {
  const result: R[] = [];
  for (let offset = 0; offset < values.length; offset += 2) {
    const rows = await Promise.allSettled(values.slice(offset, offset + 2).map(run));
    const failed = rows.find(row => row.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    result.push(...rows.map(row => (row as PromiseFulfilledResult<R>).value));
  }
  return result;
}

export function freshV4DiscoveryProgress(fact:Record<string,unknown>,capture:{block_number:string|number;revision:string|number},saved:unknown,canonicalThroughHash:string|null):FreshV4DiscoveryProgress{
  const creation=Number(fact.block_number),prior=saved as Partial<FreshV4DiscoveryProgress>|undefined;
  if(!Number.isSafeInteger(creation)||creation<0||!Number.isSafeInteger(Number(capture.block_number))||creation>Number(capture.block_number))throw Error('v4_discovery_creation_invalid');
  const reset:FreshV4DiscoveryProgress={version:1,marketProtocolsVersion:2,launchDigest:digest(fact),captureRevision:String(capture.revision),throughBlock:creation-1,throughHash:null,rangeSize:FRESH_V4_DISCOVERY_MAX_BLOCKS};
  if(!prior||prior.version!==1||prior.marketProtocolsVersion!==2||prior.launchDigest!==reset.launchDigest||prior.captureRevision!==reset.captureRevision||!Number.isSafeInteger(prior.throughBlock)
    ||Number(prior.throughBlock)<creation-1||Number(prior.throughBlock)>Number(capture.block_number))return reset;
  if(Number(prior.throughBlock)>=creation&&(!freshHash(prior.throughHash)||canonicalThroughHash!==prior.throughHash))return reset;
  if(Number(prior.throughBlock)===creation-1&&prior.throughHash!==null)return reset;
  return{...reset,throughBlock:Number(prior.throughBlock),throughHash:prior.throughHash??null,
    rangeSize:Number.isInteger(prior.rangeSize)&&Number(prior.rangeSize)>=1&&Number(prior.rangeSize)<=FRESH_V4_DISCOVERY_MAX_BLOCKS?Number(prior.rangeSize):FRESH_V4_DISCOVERY_MAX_BLOCKS};
}

/** Two indexed-token Initialize queries per official manager and bounded page. Matching
 * market receipts/headers are authenticated in full, then discarded; only
 * compact pool identities survive. This never establishes token launch. */
export async function collectFreshV4DiscoveryPage(options: { rpc: Rpc; token: string; fromBlock: number; toBlock: number; canonicalHash(number: number): Promise<string | null>; signal?: AbortSignal }): Promise<FreshV4DiscoveryPage> {
  const token = freshAddress(options.token), { fromBlock, toBlock, rpc } = options;
  if (!token || !Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock || toBlock - fromBlock >= FRESH_V4_DISCOVERY_MAX_BLOCKS) throw Error('v4_discovery_range_invalid');
  const tokenTopic = `0x${token.slice(2).padStart(64, '0')}`;
  const requests = [{manager,topic},{manager:INFINITY_CL,topic:FRESH_INFINITY_CL_INITIALIZE_TOPIC}].flatMap(venue=>[
    {...venue,topics:[venue.topic,null,tokenTopic]},{...venue,topics:[venue.topic,null,null,tokenTopic]}]);
  const responses = await boundedMap(requests, async request => {
    const topics=request.topics;
    if (options.signal?.aborted) throw Error('v4_discovery_aborted');
    const logs = await rpc<FreshLog[]>('eth_getLogs', [{ address: request.manager, fromBlock: blockHex(fromBlock), toBlock: blockHex(toBlock), topics }]);
    if (!Array.isArray(logs)) throw Error('v4_discovery_logs_invalid');
    if (logs.some(log=>log?.address?.toLowerCase()!==request.manager||log.topics[0]!==request.topic||log?.topics?.[topics[2] ? 2 : 3]!==tokenTopic)) throw Error('v4_discovery_filter_mismatch');
    if (logs.length > 64) throw Error('v4_discovery_log_limit'); return logs;
  });
  const logs = new Map<string, FreshLog>();
  for (const log of responses.flat()) {
    if (!log || log.removed || !((log.address.toLowerCase()===manager&&log.topics[0]===topic)||(log.address.toLowerCase()===INFINITY_CL&&log.topics[0]===FRESH_INFINITY_CL_INITIALIZE_TOPIC))|| log.topics?.length !== 4
      || !freshHash(log.blockHash) || !freshHash(log.transactionHash) || log.topics.some(value => !freshHash(value)) || !/^0x[\da-f]{320}$/i.test(log.data)
      || number(log.blockNumber) < fromBlock || number(log.blockNumber) > toBlock || ![log.topics[2], log.topics[3]].includes(tokenTopic)) throw Error('v4_discovery_log_invalid');
    number(log.logIndex); number(log.transactionIndex);
    const prior = logs.get(position(log)); if (prior && body(prior) !== body(log)) throw Error('v4_discovery_log_conflict'); logs.set(position(log), log);
  }
  const transactions = [...new Set([...logs.values()].map(log => log.transactionHash))];
  if (logs.size > 64 || transactions.length > FRESH_V4_DISCOVERY_MAX_RECEIPTS) throw Error('v4_discovery_log_limit');
  const blockNumbers = [...new Set([...logs.values()].map(log => number(log.blockNumber)))].sort((a, b) => a - b);
  const blocks = new Map((await boundedMap(blockNumbers, async n => {
    if (options.signal?.aborted) throw Error('v4_discovery_aborted');
    const block = await rpc<FreshBlock>('eth_getBlockByNumber', [blockHex(n), true]); validateFreshBlock(block, n);
    if (await options.canonicalHash(n) !== block.hash.toLowerCase()) throw Error('v4_discovery_noncanonical'); return [n, block] as const;
  })).map(value => value));
  const receipts = new Map((await boundedMap(transactions, async txHash => {
    if (options.signal?.aborted) throw Error('v4_discovery_aborted');
    const log = [...logs.values()].find(log => log.transactionHash === txHash)!, block = blocks.get(number(log.blockNumber))!, tx = block.transactions[number(log.transactionIndex)];
    if (!tx || tx.hash !== txHash) throw Error('v4_discovery_transaction_invalid');
    const receipt = await rpc<FreshReceipt>('eth_getTransactionReceipt', [txHash]); validateFreshReceipt(receipt, tx, block); return [txHash, receipt] as const;
  })).map(value => value));
  const identities = new Map<string, FreshSupportedMarketIdentity>(),unsupportedPools:UnsupportedPool[]=[];
  for (const log of logs.values()) {
    const receipt = receipts.get(log.transactionHash)!, matching = receipt.logs.filter(candidate => candidate.logIndex === log.logIndex);
    if (matching.length !== 1 || body(matching[0]) !== body(log)) throw Error('v4_discovery_receipt_log_mismatch');
    const infinity=log.address.toLowerCase()===INFINITY_CL,parsed = (infinity?freshInfinityClInterface:stockwavePoolManagerInterface).parseLog(log); if (!parsed || parsed.name !== 'Initialize') throw Error('v4_discovery_initialize_invalid');
    const pair = String(parsed.args.currency0).toLowerCase() === token ? String(parsed.args.currency1).toLowerCase() : String(parsed.args.currency0).toLowerCase();
    const identity = infinity?authenticateFreshInfinityClInitialization(receipt,token,log.topics[1],pair==='0x'+'0'.repeat(40)?WBNB:pair,Number(parsed.args.tick)):authenticateFreshStockwavePoolInitialization(receipt, token, log.topics[1], pair, Number(parsed.args.tick));
    if (!identity){
      if(!infinity)throw Error('v4_discovery_pool_unverified');
      // An authentic unsupported key is a diagnostic, not a failed page or
      // an approved price. Continue to later supported native pools instead
      // of permanently stopping the shared cursor at this Initialize.
      const encoded=freshInfinityClInterface.encodeEventLog(parsed.fragment,parsed.args),a=String(parsed.args.currency0).toLowerCase(),b=String(parsed.args.currency1).toLowerCase();
      const key=AbiCoder.defaultAbiCoder().encode(['address','address','address','address','uint24','bytes32'],[a,b,String(parsed.args.hooks).toLowerCase(),INFINITY_CL,parsed.args.fee,parsed.args.parameters]);
      if(encoded.data!==log.data||encoded.topics.some((t,i)=>t!==log.topics[i])||BigInt(a)>=BigInt(b)||![a,b].includes(token)||keccak256(key)!==log.topics[1])throw Error('v4_discovery_pool_unverified');
      unsupportedPools.push({manager:INFINITY_CL,poolId:log.topics[1],blockNumber:number(log.blockNumber),blockHash:log.blockHash,reason:'infinity_cl_pool_key_unsupported'});continue;
    }
    const key=marketId(identity),prior = identities.get(key); if (prior && digest(prior) !== digest(identity)) throw Error('v4_discovery_pool_conflict'); identities.set(key, identity);
  }
  const headers = [...blocks.values()].map(block => anchor(block, number(block.number)));
  const end = blocks.has(toBlock) ? anchor(blocks.get(toBlock), toBlock) : anchor(await rpc('eth_getBlockByNumber', [blockHex(toBlock), false]), toBlock);
  if (await options.canonicalHash(toBlock) !== end.hash) throw Error('v4_discovery_noncanonical');
  if (!headers.some(header => header.number === toBlock)) headers.push(end);
  return { fromBlock, toBlock, identities: [...identities.values()], headers, receipts: receipts.size,unsupportedPools };
}

/** A bounded current-identity read only; chart/page requests never scan logs. */
export async function readFreshV4MarketIdentities(database: Pick<Pool, 'query'>, tokens: string[]) {
  const addresses = [...new Set(tokens.map(token => freshAddress(token)).filter((token): token is string => Boolean(token)))].slice(0, 64);
  const rows = addresses.length ? (await database.query(`SELECT token_address,identity FROM (SELECT token_address,identity,
    row_number() OVER(PARTITION BY token_address ORDER BY CASE WHEN status='ready' THEN 0 ELSE 1 END,observed_at DESC NULLS LAST,id) AS rank
    FROM fresh.markets WHERE token_address=ANY($1::text[]) AND protocol IN('uniswap_v4','infinity_cl')) m WHERE rank<=8`, [addresses])).rows : [];
  const result = new Map<string, FreshSupportedMarketIdentity[]>();
  for (const row of rows) {
    const identity=row.identity?.market??row.identity;
    if(!freshMarketIdentityInvalid(row.identity)&&validFreshSupportedMarketIdentity(identity) && identity.tokenAddress === row.token_address){
      const list = result.get(row.token_address) ?? []; if (list.length < 8) list.push(identity); result.set(row.token_address, list);
    }
  }
  return result;
}

/** Caller owns a local transaction. Reorg and capture share this advisory lock;
 * all network work completed before it was acquired. */
export async function commitFreshV4DiscoveryPage(client: PoolClient, job: { id: string; reference: string; lease_id: string }, fact: unknown, progress: FreshV4DiscoveryProgress, page: FreshV4DiscoveryPage, now: Date) {
  await client.query('SELECT pg_advisory_xact_lock(73621941)');
  const capture = (await client.query("SELECT block_number,revision,value FROM fresh.checkpoints WHERE key='capture' FOR SHARE")).rows[0];
  const locked = (await client.query('SELECT * FROM fresh.jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
  if (!locked || locked.lease_id !== job.lease_id || new Date(locked.lease_until).getTime() <= now.getTime()) throw Error('v4_discovery_lease_changed');
  const currentFact = (await client.query("SELECT to_jsonb(lf) AS fact FROM fresh.launch_facts lf WHERE token_address=$1 AND status='eligible' FOR SHARE", [job.reference])).rows[0]?.fact;
  if (!currentFact || digest(currentFact) !== digest(fact) || String(capture?.revision) !== progress.captureRevision || Number(capture.block_number) < page.toBlock) throw Error('v4_discovery_context_changed');
  const creation=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[Number(currentFact.block_number)])).rows[0];
  if(creation?.block_hash!==currentFact.block_hash)throw Error('v4_discovery_creation_noncanonical');
  const numbers = [...new Set(page.headers.map(header => header.number))];
  const canonicalRows=(await client.query('SELECT block_number,block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=ANY($1::bigint[]) FOR SHARE', [numbers])).rows;
  const canonical = new Map(canonicalRows.map(row => [Number(row.block_number), row.block_hash]));
  if (page.headers.some(header => canonical.get(header.number) !== header.hash)) throw Error('v4_discovery_noncanonical');
  if (page.fromBlock !== progress.throughBlock + 1 || page.toBlock - page.fromBlock >= progress.rangeSize) throw Error('v4_discovery_progress_invalid');
  const last = page.headers.find(header => header.number === page.toBlock);if(!last)throw Error('v4_discovery_progress_invalid');
  let added = 0;
  for (const identity of page.identities) {
    if (!validFreshSupportedMarketIdentity(identity) || identity.tokenAddress !== job.reference || identity.initial.blockNumber < page.fromBlock || identity.initial.blockNumber > page.toBlock
      || canonical.get(identity.initial.blockNumber) !== identity.initial.blockHash) throw Error('v4_discovery_identity_invalid');
    const marked=anchorFreshMarketInitialization(identity,fact,{boundary:{number:Number(capture.value?.startBlock),hash:capture.value?.startHash},captureRevision:String(capture.revision),
      initialOccurredAt:new Date(canonicalRows.find(row=>Number(row.block_number)===identity.initial.blockNumber)!.occurred_at).toISOString(),
      confirmedThrough:{number:page.toBlock,hash:last.hash,occurredAt:new Date(canonicalRows.find(row=>Number(row.block_number)===page.toBlock)!.occurred_at).toISOString()}});
    const priorRow = (await client.query('SELECT token_address,protocol,address,identity FROM fresh.markets WHERE id=$1 FOR UPDATE', [marketId(identity)])).rows[0];
    const prior=priorRow?.identity?.market??priorRow?.identity;
    if(priorRow){
      if(priorRow.token_address!==identity.tokenAddress||priorRow.protocol!==protocol(identity)||!validFreshSupportedMarketIdentity(prior))throw Error('v4_discovery_existing_identity_invalid');
      const core=(value:unknown)=>{const{canonicalInitialization:_anchor,canonicalIdentityInvalid:_invalid,...fields}=value as Record<string,unknown>;return fields;};
      if(digest(core(prior))===digest(core(identity))&&!freshMarketIdentityInvalid(priorRow.identity)){
        // Pricing stores current conversion identity around the original market
        // proof. A duplicate history scan must preserve that ready envelope,
        // observed state and timestamps instead of replacing it with a seed.
        if(digest((prior as unknown as Record<string,unknown>).canonicalInitialization??null)!==digest(marked.canonicalInitialization)){
          const upgraded=priorRow.identity.market?{...priorRow.identity,market:marked}:marked;
          await client.query('UPDATE fresh.markets SET address=NULL,identity=$2::jsonb WHERE id=$1',[marketId(identity),JSON.stringify(upgraded)]);
        }else if(priorRow.address!==null)await client.query('UPDATE fresh.markets SET address=NULL WHERE id=$1',[marketId(identity)]);
        continue;
      }
      const original = (await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1', [prior.initial.blockNumber])).rows[0];
      if (!original || original.block_hash === prior.initial.blockHash&&!(freshMarketIdentityInvalid(priorRow.identity)&&digest(core(prior))===digest(core(identity)))) throw Error('v4_discovery_existing_identity_conflict');
    }
    const saved = await client.query(`INSERT INTO fresh.markets(id,token_address,address,protocol,quote_address,identity,status)
      VALUES($1,$2,NULL,$5,$3,$4::jsonb,'pending') ON CONFLICT(id) DO UPDATE SET address=NULL,quote_address=EXCLUDED.quote_address,identity=EXCLUDED.identity,
      state=CASE WHEN fresh.markets.identity IS DISTINCT FROM EXCLUDED.identity THEN '{}'::jsonb ELSE fresh.markets.state END,
      status=CASE WHEN fresh.markets.identity IS DISTINCT FROM EXCLUDED.identity THEN 'pending' ELSE fresh.markets.status END,
      observed_block=CASE WHEN fresh.markets.identity IS DISTINCT FROM EXCLUDED.identity THEN NULL ELSE fresh.markets.observed_block END,
      observed_hash=CASE WHEN fresh.markets.identity IS DISTINCT FROM EXCLUDED.identity THEN NULL ELSE fresh.markets.observed_hash END,
      observed_at=CASE WHEN fresh.markets.identity IS DISTINCT FROM EXCLUDED.identity THEN NULL ELSE fresh.markets.observed_at END
      WHERE fresh.markets.token_address=EXCLUDED.token_address AND fresh.markets.protocol=EXCLUDED.protocol
      AND (fresh.markets.address,fresh.markets.quote_address,fresh.markets.identity) IS DISTINCT FROM (NULL,EXCLUDED.quote_address,EXCLUDED.identity)`,
    [marketId(identity), identity.tokenAddress, identity.quoteAddress, JSON.stringify(marked),protocol(identity)]); added += saved.rowCount ?? 0;
  }
  const unsupported=page.unsupportedPools??[];
  if(unsupported.length>64||unsupported.some(p=>p.manager!==INFINITY_CL||!freshHash(p.poolId)||p.reason!=='infinity_cl_pool_key_unsupported'||p.blockNumber<page.fromBlock||p.blockNumber>page.toBlock||canonical.get(p.blockNumber)!==p.blockHash))throw Error('v4_discovery_unsupported_context_invalid');
  const updated = { ...progress, throughBlock: page.toBlock, throughHash: last.hash, rangeSize: FRESH_V4_DISCOVERY_MAX_BLOCKS,
    unsupportedMarkets:unsupported.slice(-8) };
  await client.query(`UPDATE fresh.jobs SET progress=$3::jsonb,state='pending',lease_id=NULL,lease_until=NULL,last_error=$6,
    due_at=$4::timestamptz+CASE WHEN $5::boolean THEN interval '60 seconds' ELSE interval '0 seconds' END,updated_at=clock_timestamp()
    WHERE id=$1 AND lease_id=$2`, [job.id, job.lease_id, JSON.stringify(updated), now, page.toBlock === Number(capture.block_number),unsupported.length?'infinity_cl_pool_key_unsupported':null]);
  return { blocks: page.toBlock - page.fromBlock + 1, markets: added, receipts: page.receipts,unsupportedMarkets:unsupported.length };
}

/** One leased background page; capture/urgent state always has priority. Jobs
 * retain compact cursors rather than swap histories or duplicate raw receipts. */
export async function runFreshV4MarketDiscovery(database: Pool, rpc: Rpc, options: { now?: Date; signal?: AbortSignal } = {}):Promise<{blocks:number;markets:number;receipts:number;yielded?:boolean;reason?:string}> {
  const now = options.now ?? new Date(), empty = { blocks: 0, markets: 0, receipts: 0 };
  const capture = (await database.query(`SELECT c.block_number,c.revision,b.occurred_at,h.value->>'ok' AS capture_ok,
    (SELECT count(*) FROM(SELECT 1 FROM fresh.recent_evidence e JOIN fresh.recent_blocks eb USING(block_number,block_hash)
      WHERE e.decoder_status='pending' AND eb.occurred_at>=$1::timestamptz-interval '45 seconds' LIMIT 33) urgent) AS urgent_pending
    FROM fresh.checkpoints c JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash
    LEFT JOIN fresh.checkpoints h ON h.key='health:capture' WHERE c.key='capture'`, [now])).rows[0];
  if (!capture || capture.capture_ok !== 'true' || Number(capture.urgent_pending)>32 || now.getTime() - new Date(capture.occurred_at).getTime() > 20_000 || options.signal?.aborted) return { ...empty, yielded: true, reason: 'v4_discovery_live_priority' };
  const head = number(await rpc<string>('eth_blockNumber', []));
  if (head - FRESH_CONFIRMATIONS - Number(capture.block_number) > 32) return { ...empty, yielded: true, reason: 'v4_discovery_live_priority' };
  await database.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,due_at)
    SELECT 'market_discovery:'||t.address,'market_discovery',t.address,CASE WHEN lf.protocol='evm_creation' THEN 120 WHEN lf.protocol='stockwave' THEN 100 ELSE 30 END,$1
    FROM fresh.tokens t JOIN fresh.launch_facts lf ON lf.token_address=t.address AND lf.status='eligible'
    LEFT JOIN fresh.jobs j ON j.kind='market_discovery' AND j.reference=t.address
    WHERE t.launch_status='eligible' AND t.valuation_status<>'ready' AND j.id IS NULL AND (t.last_trade_at>=$1::timestamptz-interval '1 day'
      OR EXISTS(SELECT 1 FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id WHERE s.active AND p.token_address=t.address AND p.quantity_q<>'0'
        AND EXISTS(SELECT 1 FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id
          WHERE r.scope_id=p.scope_id AND e.token_address=t.address AND e.canonical AND e.kind IN('buy','sell'))))
    ORDER BY CASE WHEN lf.protocol='evm_creation' THEN 0 WHEN lf.protocol='stockwave' THEN 1 ELSE 2 END,t.last_trade_at DESC NULLS LAST,t.address LIMIT 8
    ON CONFLICT(kind,reference) DO NOTHING`, [now]);
  const lease = randomUUID(), job = (await database.query(`UPDATE fresh.jobs SET lease_id=$2,lease_until=$1::timestamptz+interval '45 seconds',updated_at=clock_timestamp()
    WHERE id=(SELECT id FROM fresh.jobs WHERE kind='market_discovery' AND state='pending' AND due_at<=$1 AND (lease_until IS NULL OR lease_until<=$1)
      ORDER BY due_at,priority DESC,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [now, lease])).rows[0];
  if (!job) return empty;
  try {
    const fact = (await database.query("SELECT to_jsonb(lf) AS fact FROM fresh.launch_facts lf JOIN fresh.tokens t ON t.address=lf.token_address AND t.launch_status='eligible' WHERE token_address=$1 AND status='eligible'", [job.reference])).rows[0]?.fact;
    if (!fact || !Number.isSafeInteger(Number(fact.block_number))) throw Error('v4_discovery_launch_unavailable');
    if((await database.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[Number(fact.block_number)])).rows[0]?.block_hash!==fact.block_hash)throw Error('v4_discovery_creation_noncanonical');
    const saved=job.progress as Partial<FreshV4DiscoveryProgress>;
    const canonicalThroughHash=Number.isSafeInteger(saved?.throughBlock)?(await database.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[saved.throughBlock])).rows[0]?.block_hash??null:null;
    const progress=freshV4DiscoveryProgress(fact,capture,saved,canonicalThroughHash),through=progress.throughBlock,rangeSize=progress.rangeSize;
    if (through >= Number(capture.block_number)) {
      await database.query("UPDATE fresh.jobs SET lease_id=NULL,lease_until=NULL,due_at=$3::timestamptz+interval '60 seconds' WHERE id=$1 AND lease_id=$2", [job.id, lease, now]); return empty;
    }
    const hashes = new Map<number, Promise<string | null>>();
    const canonicalHash = (n: number) => { let value = hashes.get(n); if (!value) { value = database.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1', [n]).then(row => row.rows[0]?.block_hash ?? null); hashes.set(n, value); } return value; };
    const toBlock = Math.min(Number(capture.block_number), through + rangeSize);
    let page: FreshV4DiscoveryPage;
    try { page = await collectFreshV4DiscoveryPage({ rpc, token: job.reference, fromBlock: through + 1, toBlock, canonicalHash, signal: options.signal }); }
    catch (error) {
      if (error instanceof Error && error.message === 'v4_discovery_log_limit' && rangeSize > 1) {
        await database.query("UPDATE fresh.jobs SET progress=$3::jsonb,lease_id=NULL,lease_until=NULL,due_at=$4,last_error='v4_discovery_page_shrunk' WHERE id=$1 AND lease_id=$2", [job.id, lease, JSON.stringify({ ...progress, rangeSize: Math.max(1, Math.floor(rangeSize / 2)) }), now]);
        return { ...empty, reason: 'v4_discovery_page_shrunk' };
      } throw error;
    }
    const client = await database.connect();
    try { await client.query('BEGIN'); const result = await commitFreshV4DiscoveryPage(client, { ...job, lease_id: lease }, fact, progress, page, new Date()); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch (error) {
    const reason = error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message) ? error.message : 'v4_discovery_unavailable';
    await database.query(`UPDATE fresh.jobs SET lease_id=NULL,lease_until=NULL,attempts=attempts+1,last_error=$3,
      due_at=$4::timestamptz+least(600,30*power(2,least(attempts,5)))*interval '1 second',updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2`, [job.id, lease, reason, now]);
    return { ...empty, reason };
  }
}
