import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { Rpc } from '../rpc.js';
import { decodeFreshEvidence, freshAddress, freshHash, freshInteger,FRESH_CONFIRMATIONS, type FreshCapturedReceipt,type FreshCaptureProgress } from './capture.js';
import { createFreshStateEvidenceRpc } from './stateEvidence.js';
import type { FreshMetadataRecoveryBlock } from './metadataRecovery.js';

export interface FreshRecoverySource { entry: FreshCapturedReceipt; payload: Buffer; block: FreshMetadataRecoveryBlock }
/** A retained proof supplies only an exact lookup hint. Reloaded original raw
 * evidence and the independent template verifier still establish precision. */
export interface FreshRecoverySourceHint { transactionHash:string;blockNumber:number;blockHash:string;payloadSha256:string }
export type FreshRecoveryCaptureHealth = FreshCaptureProgress;
export interface FreshRecoveryBatch {
  sources(token: string, target: FreshMetadataRecoveryBlock, hint?:FreshRecoverySourceHint): Promise<FreshRecoverySource[]>;
  /** Only immutable, block-identified inputs belong here. Errors are not cached. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
  stats(): { scannedRows: number; scannedBytes: number; decodedBytes: number; indexedReferences: number; truncated: boolean; scans: number;
    memoEntries: number; memoBytes: number; cycle: number; cycleScannedRows: number; cycleComplete: boolean; cursorBlock: number;
    cycleCeilingBlock: number; totalScannedRows: number; tailScannedRows: number; oversizedRows: number; evictedTokens: number;sliceIntervalMs:number };
}
type Locator = { tx: string; hash: string; number: number; index: number; expiresAt: number };
const key = (row: Locator) => `${row.tx}:${row.hash}`;
const compare = (a: Locator, b: Locator) => a.number - b.number || a.index - b.index || a.tx.localeCompare(b.tx) || a.hash.localeCompare(b.hash);
const blockOf = (row: any): FreshMetadataRecoveryBlock => ({ number: Number(row.block_number), hash: row.block_hash, timestamp: new Date(row.occurred_at).toISOString() });
const selector = '0x313ce567';
const integer = (value: number | undefined, fallback: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, Number.isSafeInteger(value) ? value! : fallback));
/** Scheduling only. Every source still reloads its original proof and headers. */
export function freshRecoveryCaptureHealthy(value:FreshRecoveryCaptureHealth|undefined,head:number,now:number){
  if(!value||![value.checkedAt,value.nodeHead,value.confirmedHeadBlock,value.capturedBlock,value.lagBlocks,head,now].every(Number.isSafeInteger)
    ||value.checkedAt>now||now-value.checkedAt>5_000||value.nodeHead<0||value.capturedBlock<0||value.capturedBlock>head||value.capturedBlock>value.confirmedHeadBlock
    ||value.confirmedHeadBlock!==Math.max(0,value.nodeHead-FRESH_CONFIRMATIONS)
    ||value.lagBlocks!==Math.max(0,value.confirmedHeadBlock-value.capturedBlock))return false;
  return value.lagBlocks<=32&&Math.max(0,value.confirmedHeadBlock-head)<=32;
}

/** A small, disposable locator index over the existing 72-hour receipt buffer.
 * It stores no financial responses and authorizes nothing by itself. Every
 * source use reloads its current checksum-protected payload, expiry and both
 * canonical headers. Pending/repair receipts may contain valid raw reads even
 * though their economic interpretation is incomplete.
 *
 * Timed, budgeted slices retain their keyset cursor and index across batches.
 * A fixed capture ceiling makes each cycle finite; the next cycle revisits
 * older envelopes that gained successful reads. A small recent-head pass
 * discovers fresh reads while historical warming continues. Only a changed
 * capture revision/boundary discards the index. Memo TTL is independent.
 * Budget exhaustion means incomplete recovery, never guessed precision.
 */
export function createFreshRecoveryBatch(database: Pick<Pool, 'query'>, _rpc: Rpc, options: {
  now?: () => number; ttlMs?: number; maxRows?: number; maxBytes?: number; pageSize?: number; maxDecodedBytes?: number; maxSliceMs?: number;
  captureHealth?:()=>FreshRecoveryCaptureHealth|undefined;
} = {}): FreshRecoveryBatch {
  const now = options.now ?? Date.now, ttl = integer(options.ttlMs, 60_000, 1, 60_000);
  const maxRows = integer(options.maxRows, 16_384, 1, 16_384), maxBytes = integer(options.maxBytes, 64 * 1024 * 1024, 1, 64 * 1024 * 1024);
  const pageSize = integer(options.pageSize, 128, 1, 128), maxPayload = 2 * 1024 * 1024;
  const maxDecoded = integer(options.maxDecodedBytes, 128 * 1024 * 1024, 1, 128 * 1024 * 1024);
  const maxSliceMs=integer(options.maxSliceMs,500,1,1000);
  const index = new Map<string, Locator[]>(), work = new Map<string, Promise<unknown>>();
  const beginning=():Locator=>({number:-1,index:-1,tx:'',hash:'',expiresAt:0});
  let revision = '', memoExpires = 0, lastSliceAt:number|null=null,sliceIntervalMs=ttl, scan: Promise<void> | undefined, generation = 0, memoGeneration=0,memoBytes = 0;
  let cursor=beginning(),cycle=0,cycleScannedRows=0,cycleComplete=false,cycleCeiling=0,totalScannedRows=0;
  let metrics = { scannedRows: 0, scannedBytes: 0,decodedBytes:0, indexedReferences: 0, truncated: false, scans: 0,tailScannedRows:0,oversizedRows:0,evictedTokens:0 };
  function resetMemo(){memoGeneration++;memoExpires=now()+ttl;work.clear();memoBytes=0;}
  function beginCycle(head:number){cursor=beginning();cycle++;cycleScannedRows=0;cycleComplete=false;cycleCeiling=head;}
  function reset(nextRevision: string,head:number) {
    revision=nextRevision;generation++;index.clear();resetMemo();scan=undefined;lastSliceAt=null;sliceIntervalMs=ttl;totalScannedRows=0;beginCycle(head);
  }
  async function epoch() {
    const row = (await database.query("SELECT revision,value->>'startBlock' AS start_block,block_number FROM fresh.checkpoints WHERE key='capture'")).rows[0];
    if (!row || !Number.isSafeInteger(Number(row.revision)) || !Number.isSafeInteger(Number(row.start_block))||!Number.isSafeInteger(Number(row.block_number))) throw Error('recovery_batch_checkpoint_invalid');
    const next = `${row.revision}:${row.start_block}`;
    if (next !== revision)reset(next,Number(row.block_number));
    else if(now()>=memoExpires)resetMemo();
    return {generation,head:Number(row.block_number)};
  }
  function prune(){
    for(const[token,rows]of index){const alive=rows.filter(row=>row.expiresAt>now());if(alive.length)index.set(token,alive);else index.delete(token);}
  }
  function retain(token: string, locator: Locator) {
    if (!index.has(token) && index.size >= 1024) {index.delete(index.keys().next().value!);metrics.evictedTokens++;metrics.truncated=true;}
    const rows = index.get(token) ?? [];
    if (rows.some(row => key(row) === key(locator))) return;
    rows.push(locator); rows.sort(compare);
    // Earliest reads support old targets; latest reads also support pool repair.
    if (rows.length > 16) rows.splice(8, rows.length - 16);
    index.delete(token);index.set(token, rows);
  }
  async function build(expected: number,head:number) {
    metrics = { scannedRows: 0, scannedBytes: 0,decodedBytes:0, indexedReferences: 0, truncated: false, scans: metrics.scans + 1,tailScannedRows:0,oversizedRows:0,evictedTokens:0 };
    prune();if(cycleComplete)beginCycle(head);
    const started=performance.now(),hasTime=()=>performance.now()-started<maxSliceMs;
    // A recent oversized/slow receipt must never starve the historical cursor.
    // Reserve the first bounded record for history before optional tail work.
    const initial=await historicalRows(1);
    if(generation!==expected)return;
    if(initial.length){if(!consume(initial[0],true)){metrics.truncated=true;return;}}
    else cycleComplete=true;
    // Recent metadata cannot wait behind a large historical receipt prefix.
    // This pass shares the slice's budgets and never advances history's cursor.
    const tail=metrics.scannedRows<maxRows&&performance.now()-started<maxSliceMs/2?(await database.query(`SELECT e.tx_hash,e.block_hash,e.block_number,e.transaction_index,b.occurred_at,e.expires_at,
      octet_length(e.payload) AS payload_bytes,CASE WHEN octet_length(e.payload)<=$4 THEN e.payload END AS payload
      FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
      WHERE e.expires_at>$1 AND b.occurred_at>=$2 AND e.block_number<=$3
      ORDER BY e.block_number DESC,e.transaction_index DESC,e.tx_hash DESC LIMIT 2`,
      [new Date(now()),new Date(now()-300_000),head,maxPayload])).rows:[];
    let tailDecoded=0;
    for(const row of tail){
      if(generation!==expected)return;
      if(metrics.scannedRows>=maxRows||metrics.tailScannedRows>=2||performance.now()-started>=maxSliceMs/2||tailDecoded>=Math.min(16*1024*1024,maxDecoded/4))break;
      const before=metrics.decodedBytes;if(!consume(row,false,{bytes:maxBytes/4,decoded:Math.min(16*1024*1024,maxDecoded/4)}))break;
      tailDecoded+=metrics.decodedBytes-before;metrics.tailScannedRows++;
    }
    while (!cycleComplete&&metrics.scannedRows < maxRows && metrics.scannedBytes < maxBytes && generation === expected) {
      if(!hasTime()){metrics.truncated=true;break;}
      const requestedRows=Math.min(pageSize,maxRows-metrics.scannedRows);
      const rows=await historicalRows(requestedRows);
      if (!rows.length) {cycleComplete=true;break;}
      for (const row of rows) {
        if (generation !== expected) return;
        if(!hasTime()||!consume(row,true)){metrics.truncated=true;return;}
      }
      if (rows.length < requestedRows) {cycleComplete=true;break;}
    }
    metrics.indexedReferences = [...index.values()].reduce((sum, rows) => sum + rows.length, 0);
    if (metrics.scannedRows >= maxRows || metrics.scannedBytes >= maxBytes) metrics.truncated = true;
    async function historicalRows(requestedRows:number){
      return (await database.query(`WITH candidates AS (
        SELECT e.tx_hash,e.block_hash,e.block_number,e.transaction_index,b.occurred_at,e.expires_at,e.payload,octet_length(e.payload) AS payload_bytes
        FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
        WHERE e.expires_at>$1 AND (e.block_number,e.transaction_index,e.tx_hash,e.block_hash)>($2,$3,$4,$5) AND e.block_number<=$9
        ORDER BY e.block_number,e.transaction_index,e.tx_hash,e.block_hash LIMIT $6
      ), budgeted AS (SELECT *,sum(CASE WHEN payload_bytes<=$7 THEN payload_bytes ELSE 0 END)
        OVER(ORDER BY block_number,transaction_index,tx_hash,block_hash) AS page_bytes FROM candidates)
      SELECT tx_hash,block_hash,block_number,transaction_index,occurred_at,expires_at,payload_bytes,
        CASE WHEN payload_bytes<=$7 AND page_bytes<=$8 THEN payload END AS payload FROM budgeted
      ORDER BY block_number,transaction_index,tx_hash,block_hash`,
      [new Date(now()), cursor.number, cursor.index, cursor.tx, cursor.hash, requestedRows, maxPayload,
        Math.min(4 * 1024 * 1024, maxBytes - metrics.scannedBytes),cycleCeiling])).rows;
    }
    function consume(row:any,historical:boolean,budget={bytes:maxBytes,decoded:maxDecoded}){
      const locator:Locator={tx:row.tx_hash,hash:row.block_hash,number:Number(row.block_number),index:Number(row.transaction_index),expiresAt:new Date(row.expires_at).getTime()};
      const advance=()=>{metrics.scannedRows++;totalScannedRows++;if(historical){cursor=locator;cycleScannedRows++;}};
      const bytes=Number(row.payload_bytes);
      if(!Number.isSafeInteger(bytes)||bytes<0||bytes>maxPayload){metrics.oversizedRows++;metrics.truncated=true;advance();return true;}
      // A missing body due to the page budget must be retried next slice.
      if(!Buffer.isBuffer(row.payload)||metrics.scannedBytes+bytes>budget.bytes)return false;
      let entry:FreshCapturedReceipt,decoded:number;
      try{entry=decodeFreshEvidence(row.payload);decoded=Buffer.byteLength(JSON.stringify(entry));}
      catch{metrics.scannedBytes+=bytes;advance();return true;}
        if(decoded>maxDecoded){metrics.oversizedRows++;metrics.truncated=true;advance();return true;}
        if(metrics.decodedBytes+decoded>budget.decoded)return false;
        metrics.scannedBytes+=bytes;metrics.decodedBytes+=decoded;advance();
      try{
        const block=blockOf(row);if(!validSource(entry,row,block))return true;
        const state=createFreshStateEvidenceRpc(_rpc,block,entry.stateEvidence);if(state.rejectedPrior)return true;
        for(const call of state.snapshot()?.calls??[])if(call.data===selector&&/^0x[\da-f]{64}$/i.test(call.result))retain(call.to,locator);
      }catch{/* A rejected saved-state envelope is counted once, never indexed. */}
      return true;
    }
  }
  function validSource(entry: FreshCapturedReceipt, row: any, block: FreshMetadataRecoveryBlock) {
    try { return freshHash(row.tx_hash) === entry.transaction.hash.toLowerCase() && entry.receipt.transactionHash.toLowerCase() === row.tx_hash
      && entry.transaction.blockHash.toLowerCase() === block.hash && entry.receipt.blockHash.toLowerCase() === block.hash
      && Number(freshInteger(entry.transaction.blockNumber)) === block.number && Number(freshInteger(entry.receipt.blockNumber)) === block.number
      && Number(freshInteger(entry.transaction.transactionIndex)) === Number(row.transaction_index)
      && Number(freshInteger(entry.receipt.transactionIndex)) === Number(row.transaction_index); } catch { return false; }
  }
  function validatedHint(value:unknown,target:FreshMetadataRecoveryBlock):FreshRecoverySourceHint|null {
    try{
      if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>1024)return null;
      const h=value as Record<string,unknown>,keys=Object.keys(h);
      if(keys.length!==4||!['transactionHash','blockNumber','blockHash','payloadSha256'].every(key=>Object.hasOwn(h,key))
        ||!freshHash(h.transactionHash)||!freshHash(h.blockHash)||!Number.isSafeInteger(h.blockNumber)||Number(h.blockNumber)<0||Number(h.blockNumber)>=target.number
        ||typeof h.payloadSha256!=='string'||!/^[\da-f]{64}$/i.test(h.payloadSha256))return null;
      return{transactionHash:freshHash(h.transactionHash)!,blockNumber:Number(h.blockNumber),blockHash:freshHash(h.blockHash)!,payloadSha256:h.payloadSha256.toLowerCase()};
    }catch{return null;}
  }
  async function reload(token:string,target:FreshMetadataRecoveryBlock,locators:Pick<Locator,'tx'|'hash'|'number'>[],expected:number,budget:{compressed:number;decoded:number},payloadSha256?:string) {
    if(!locators.length)return[];
    const rows = (await database.query(`SELECT e.tx_hash,e.block_hash,e.block_number,e.transaction_index,e.payload,b.occurred_at
      FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
      JOIN fresh.recent_blocks target ON target.block_number=$3 AND target.block_hash=$4 AND target.occurred_at=$5
      WHERE e.tx_hash=ANY($1::text[]) AND e.block_hash=ANY($2::text[]) AND e.expires_at>$6
        AND e.block_number<$3 AND octet_length(e.payload)<=$7
      ORDER BY e.block_number DESC,e.transaction_index DESC LIMIT 16`,
    [locators.map(row=>row.tx),locators.map(row=>row.hash),target.number,target.hash.toLowerCase(),target.timestamp,new Date(now()),maxPayload])).rows;
    if(generation!==expected)return[];
    const result:FreshRecoverySource[]=[];
    for(const row of rows)try{
      if(!locators.some(locator=>locator.tx===row.tx_hash&&locator.hash===row.block_hash&&locator.number===Number(row.block_number)))continue;
      budget.compressed+=row.payload.length;if(budget.compressed>64*1024*1024)break;
      if(payloadSha256&&createHash('sha256').update(row.payload).digest('hex')!==payloadSha256)continue;
      const entry=decodeFreshEvidence(row.payload),block=blockOf(row);budget.decoded+=Buffer.byteLength(JSON.stringify(entry));
      if(budget.decoded>16*1024*1024)break;if(!validSource(entry,row,block))continue;
      const state=createFreshStateEvidenceRpc(_rpc,block,entry.stateEvidence);
      if(state.rejectedPrior||!state.snapshot()?.calls.some(call=>call.to===token&&call.data===selector&&/^0x[\da-f]{64}$/i.test(call.result)))continue;
      result.push({entry,payload:row.payload,block});
    }catch{/* A malformed hint cannot give corrupt, expired or orphan evidence authority. */}
    return result;
  }
  return {
    async sources(value, target, hint) {
      const token = freshAddress(value); if (!token || !freshHash(target.hash) || !Number.isSafeInteger(target.number)) return [];
      const epochState = await epoch(),expected=epochState.generation,budget={compressed:0,decoded:0};
      const direct=validatedHint(hint,target);
      if(direct){
        const found=await reload(token,target,[{tx:direct.transactionHash,hash:direct.blockHash,number:direct.blockNumber}],expected,budget,direct.payloadSha256);
        if(generation!==expected)return[];
        if(found.length)return found;
      }
      // Cold historical warming can use spare capture capacity. A failed/stale
      // capture or completed cycle returns to the normal minute interval;
      // memo TTL, slice work limits and all per-use proof gates stay unchanged.
      sliceIntervalMs=!cycleComplete&&freshRecoveryCaptureHealthy(options.captureHealth?.(),epochState.head,now())?Math.min(ttl,5_000):ttl;
      if (!scan&&(lastSliceAt===null||now()-lastSliceAt>=sliceIntervalMs)){
        lastSliceAt=now();
        const active=build(expected,epochState.head);scan=active;
        void active.finally(()=>{if(scan===active)scan=undefined;}).catch(()=>{});
      }
      if(scan)await scan;
      if (generation !== expected) return [];
      prune();
      const locators = (index.get(token) ?? []).filter(row => row.number < target.number);
      return reload(token,target,locators,expected,budget);
    },
    async memo<T>(cacheKey: string, load: () => Promise<T>) {
      await epoch();const expected=memoGeneration;
      let pending = work.get(cacheKey);
      if (!pending) {
        if (work.size >= 256) { metrics.truncated = true; throw Error('recovery_batch_work_limit'); }
        pending = load().then(value => {
          if (memoGeneration === expected && work.get(cacheKey) === pending) {
            const bytes = Buffer.byteLength(JSON.stringify(value) ?? 'null');
            if (bytes > 2 * 1024 * 1024 || memoBytes + bytes > 8 * 1024 * 1024) work.delete(cacheKey); else memoBytes += bytes;
          }
          return value;
        }).catch(error => { if (work.get(cacheKey) === pending) work.delete(cacheKey); throw error; });
        work.set(cacheKey, pending);
      }
      return pending as Promise<T>;
    },
    stats: () => ({ ...metrics, indexedReferences: [...index.values()].reduce((sum, rows) => sum + rows.length, 0), memoEntries: work.size, memoBytes,
      cycle,cycleScannedRows,cycleComplete,cursorBlock:cursor.number,cycleCeilingBlock:cycleCeiling,totalScannedRows,sliceIntervalMs }),
  };
}
