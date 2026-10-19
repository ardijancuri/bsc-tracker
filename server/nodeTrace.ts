import net from 'node:net';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { hasRecognizedSwap, nativeSellProceeds, type TransferLog } from './swap.js';
import { isExcludedKolProfileTokenAddress } from './kolProfileToken.js';
import { FLAP_PORTAL, FOUR_MANAGERS } from './launchpad.js';
import { flapMarketAbi, fourMarketAbi } from './nodeMarketProtocols.js';
import { invalidateNodeLeaderboardForWallets } from './nodeAccountingSchema.js';

export type NodeCallTrace = { type: string; from: string; to?: string; value?: string; error?: string; calls?: NodeCallTrace[] };
export function nodeNativeTradeValue(input:{wallet:string;side:'buy'|'sell';token:string;tokenAmountRaw:bigint;logs:TransferLog[];transactionTo?:string|null;trace?:NodeCallTrace|null}):{amount:bigint|null;reason?:'native_trace_required'|'native_payout_mismatch'} {
  const traced=input.trace?nodeTraceNativeDelta(input.trace,input.wallet):null;
  if(input.side==='buy')return {amount:traced!==null&&traced<=0n?-traced:null,...(traced===null?{reason:'native_trace_required' as const}:traced>0n?{reason:'native_payout_mismatch' as const}:{})};
  const strictRouter=input.transactionTo==='0xb300000b72deaeb607a12d5f54773d1c19c7028d'?input.transactionTo:null;
  const receipt=nativeSellProceeds(input.wallet,input.tokenAmountRaw,input.logs,strictRouter,input.token);
  if(receipt!==null&&traced!==null&&receipt!==traced)return {amount:null,reason:'native_payout_mismatch' as const};
  if(receipt!==null)return {amount:receipt};
  return {amount:traced!==null&&traced>=0n?traced:null,...(traced===null?{reason:'native_trace_required' as const}:traced<0n?{reason:'native_payout_mismatch' as const}:{})};
}
const address = /^0x[0-9a-f]{40}$/i, quantity = /^0x[0-9a-f]{1,64}$/i;
export function validateNodeTrace(value: unknown, maxNodes = 5000): NodeCallTrace {
  let count = 0;
  const visit = (raw: any, depth: number): NodeCallTrace => {
    if (++count > maxNodes || depth > 32 || !raw || typeof raw !== 'object' || !address.test(raw.from ?? '') || typeof raw.type !== 'string'
      || raw.to != null && !address.test(raw.to) || raw.value != null && !quantity.test(raw.value) || raw.calls != null && !Array.isArray(raw.calls)) throw new Error('node_trace_bounds_invalid');
    return { type: raw.type, from: raw.from.toLowerCase(), ...(raw.to ? { to: raw.to.toLowerCase() } : {}), ...(raw.value ? { value: raw.value } : {}),
      ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, 200) } : {}), ...(raw.calls?.length ? { calls: raw.calls.map((child: unknown) => visit(child, depth + 1)) } : {}) };
  };
  return visit(value, 0);
}

/** Only a bounded callTracer is available. This accepts a local IPC socket,
 * never an HTTP debug endpoint or arbitrary RPC method/options. Mounting the
 * node socket into a worker is an explicit deployment configuration step. */
export async function traceNodeTransaction(txHash: string, options: { ipcPath?: string; timeoutMs?: number } = {}): Promise<NodeCallTrace | null> {
  if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error('node_trace_hash_invalid');
  const ipcPath = options.ipcPath ?? process.env.BSC_TRACE_IPC;
  if (!ipcPath) return null;
  if (!isAbsolute(ipcPath) || /^https?:/i.test(ipcPath)) throw new Error('node_trace_ipc_path_invalid');
  const info = await stat(ipcPath);
  if (!info.isSocket() || info.mode & 0o007) throw new Error('node_trace_ipc_permissions_invalid');
  const timeout = Math.min(5000, Math.max(100, options.timeoutMs ?? 3000));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ipcPath), id = 1; let buffer = '', finished = false;
    const done = (error?: Error, result?: NodeCallTrace) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result!); };
    const timer = setTimeout(() => done(new Error('node_trace_timeout')), timeout);
    socket.on('error', error => done(error)); socket.on('end', () => { if (!finished) done(new Error('node_trace_incomplete')); });
    socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'debug_traceTransaction', params: [txHash.toLowerCase(), { tracer: 'callTracer', timeout: '2s', reexec: 128, tracerConfig: { onlyTopCall: false, withLog: false } }] }) + '\n'));
    socket.on('data', data => {
      buffer += data.toString('utf8'); if (Buffer.byteLength(buffer) > 2_000_000) return done(new Error('node_trace_response_too_large'));
      let body; try { body = JSON.parse(buffer); } catch { return; }
      if (body.id !== id || body.error || !body.result) return done(new Error(body.error && /historical state|missing trie|state.*unavailable|state.*not available|pruned/i.test(String(body.error.message))
        ?'node_trace_state_unavailable':'node_trace_unavailable'));
      try { done(undefined, validateNodeTrace(body.result)); } catch (error) { done(error as Error); }
    });
  });
}

type TraceExecution = { id:string;txHash:string;walletAddress:string;kind:string;status:string;nativeValueRaw:string;logs:TransferLog[];transactionTo?:string|null;
  flows:{tokenAddress:string;deltaRaw:string}[] };
type TraceDatabase={query:(sql:string,args?:any[])=>Promise<any>};
/** Only single-token native swap evidence is a tracing candidate. Ordinary
 * native payments, token transfers, known quote legs and whole AA bundles are
 * outside this queue. Launchpad events must come from the pinned controller. */
export function nodeExecutionNeedsTrace(execution:TraceExecution,transactionTo=execution.transactionTo) {
  if(execution.kind!=='transaction'||execution.status!=='success')return false;
  const eligible=execution.flows.filter(flow=>!isExcludedKolProfileTokenAddress(flow.tokenAddress)&&BigInt(flow.deltaRaw)!==0n);
  if(eligible.length!==1)return false;
  const target=eligible[0],raw=BigInt(target.deltaRaw),positive=raw>0n;
  if(execution.flows.some(flow=>flow.tokenAddress!==target.tokenAddress&&BigInt(flow.deltaRaw)!==0n&&(BigInt(flow.deltaRaw)<0n)===positive))return false;
  const launchSwap=execution.logs.some(log=>{
    const contract=log.address.toLowerCase(),abi=contract===FLAP_PORTAL?flapMarketAbi:FOUR_MANAGERS.includes(contract)?fourMarketAbi:null;
    if(!abi)return false;
    try{const parsed=abi.parseLog(log);return !!parsed&&String(parsed.args.token).toLowerCase()===target.tokenAddress
      &&String(parsed.args.account??parsed.args.buyer??parsed.args.seller).toLowerCase()===execution.walletAddress;}catch{return false;}
  });
  if(!hasRecognizedSwap(execution.logs)&&!launchSwap)return false;
  if(positive)return BigInt(execution.nativeValueRaw)>0n;
  return nodeNativeTradeValue({wallet:execution.walletAddress,side:'sell',token:target.tokenAddress,tokenAmountRaw:-raw,logs:execution.logs,transactionTo}).amount===null;
}

export async function ensureNodeTraceSchema(database:TraceDatabase) {
  await database.query(`SELECT pg_advisory_xact_lock(782348);
    CREATE TABLE IF NOT EXISTS node_trace_jobs(
    tx_hash text PRIMARY KEY REFERENCES node_evidence_transactions(tx_hash) ON DELETE CASCADE,block_hash text NOT NULL,
    state text NOT NULL DEFAULT 'pending',priority integer NOT NULL DEFAULT 0,requested_at timestamptz NOT NULL DEFAULT now(),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,last_error text,
    lease_id uuid,lease_until timestamptz,completed_at timestamptz);
    CREATE INDEX IF NOT EXISTS node_trace_jobs_pending ON node_trace_jobs(priority DESC,next_attempt_at,requested_at) WHERE state='pending';`);
}

export async function queueNodeTraceExecutions(database:TraceDatabase,executions:TraceExecution[]) {
  const needed=executions.filter(execution=>nodeExecutionNeedsTrace(execution));
  if(!needed.length)return 0;
  const result=await database.query(`INSERT INTO node_trace_jobs(tx_hash,block_hash)
    SELECT DISTINCT t.tx_hash,t.block_hash FROM node_evidence_transactions t
    JOIN node_evidence_blocks b ON b.block_number=t.block_number AND b.block_hash=t.block_hash
    WHERE t.tx_hash=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM node_trace_evidence saved WHERE saved.tx_hash=t.tx_hash AND saved.block_hash=t.block_hash)
    ON CONFLICT(tx_hash)DO NOTHING`,[[...new Set(needed.map(execution=>execution.txHash))]]);
  return result.rowCount??0;
}

/** A selected old execution may be queued from saved evidence, without any RPC
 * scan. Unavailable historical state remains an explicit bounded repair job. */
export async function queueNodeTraceRepairs(database:TraceDatabase,options:{wallet:string;token:string;limit?:number}) {
  if(!address.test(options.wallet)||!address.test(options.token))throw new Error('node_trace_identity_invalid');
  const rows=(await database.query(`SELECT e.id,e.tx_hash,e.wallet_address,e.kind,e.status,e.native_value_raw::text,e.logs,
    min(t.transaction->>'to') AS transaction_to,
    jsonb_agg(jsonb_build_object('tokenAddress',f.token_address,'deltaRaw',f.delta_raw::text))AS flows
    FROM node_executions e JOIN node_execution_flows f ON f.execution_id=e.id
    JOIN node_evidence_transactions t ON t.tx_hash=e.tx_hash AND t.block_hash=e.block_hash
    WHERE e.wallet_address=$1 AND e.kind='transaction' AND e.status='success'
    AND EXISTS(SELECT 1 FROM node_execution_flows target WHERE target.execution_id=e.id AND target.token_address=$2)
    AND NOT EXISTS(SELECT 1 FROM node_trace_jobs j WHERE j.tx_hash=e.tx_hash)
    GROUP BY e.id ORDER BY e.block_number DESC,e.transaction_index DESC LIMIT $3`,[options.wallet.toLowerCase(),options.token.toLowerCase(),Math.min(16,Math.max(1,options.limit??4))])).rows;
  return queueNodeTraceExecutions(database,rows.map((row:any)=>({id:row.id,txHash:row.tx_hash,walletAddress:row.wallet_address,kind:row.kind,status:row.status,
    nativeValueRaw:row.native_value_raw,transactionTo:row.transaction_to,logs:row.logs,flows:row.flows})));
}

export function nodeTraceMatchesTransaction(trace:NodeCallTrace,transaction:{from?:unknown;to?:unknown;value?:unknown}) {
  if(typeof transaction.from!=='string'||trace.from!==transaction.from.toLowerCase()||trace.error
    ||typeof transaction.value!=='string'||!quantity.test(transaction.value)||BigInt(trace.value??'0x0')!==BigInt(transaction.value))return false;
  return transaction.to==null?['CREATE','CREATE2'].includes(trace.type.toUpperCase())
    :typeof transaction.to==='string'&&trace.to===transaction.to.toLowerCase()&&trace.type.toUpperCase()==='CALL';
}

/** A reverted subtree creates no movement. CALLCODE/DELEGATECALL do not move
 * balances between their asserted addresses and are deliberately excluded. */
export function nodeTraceNativeDelta(trace: NodeCallTrace, wallet: string): bigint {
  let total = 0n; const target = wallet.toLowerCase();
  const visit = (call: NodeCallTrace) => {
    if (call.error) return;
    if (['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(call.type.toUpperCase()) && call.value && call.from !== call.to) {
      const value = BigInt(call.value); if (call.from === target) total -= value; if (call.to === target) total += value;
    }
    call.calls?.forEach(visit);
  }; visit(trace); return total;
}

/** Trace jobs are optional enrichment over permanently captured evidence. The
 * trace cannot move the collection cursor or authenticate another block hash. */
export async function captureNodeTraceBatch(database: Pick<Pool, 'query' | 'connect'>,
  options: { ipcPath?: string; limit?: number; trace?: typeof traceNodeTransaction } = {}) {
  if (!options.ipcPath && !process.env.BSC_TRACE_IPC && !options.trace) return { captured: 0, unavailable: 0 };
  const coordinator=await database.connect();let locked=false;
  try {
  locked=!!(await coordinator.query('SELECT pg_try_advisory_lock(782347) AS acquired')).rows[0]?.acquired;
  if(!locked)return {captured:0,unavailable:0,busy:true};
  const lease=randomUUID();
  const rows = await database.query(`UPDATE node_trace_jobs j SET lease_id=$1,lease_until=clock_timestamp()+interval '10 seconds',attempts=j.attempts+1
    WHERE j.tx_hash IN(SELECT q.tx_hash FROM node_trace_jobs q JOIN node_evidence_transactions e ON e.tx_hash=q.tx_hash AND e.block_hash=q.block_hash
      JOIN node_evidence_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash
      WHERE q.state='pending' AND q.next_attempt_at<=now() AND(q.lease_until IS NULL OR q.lease_until<now()) AND e.receipt->>'status'='0x1'
      ORDER BY q.priority DESC,e.block_number DESC,e.transaction_index DESC LIMIT $2 FOR UPDATE OF q SKIP LOCKED)
    RETURNING j.tx_hash,j.block_hash,j.attempts`, [lease,Math.min(4, Math.max(1, options.limit ?? 2))]);
  let captured = 0, unavailable = 0;
  // A crashed process must release usable native-state work before pruning.
  // Renew the whole bounded batch while alive, including jobs waiting behind
  // another trace. An expired lease cannot be resurrected by a late heartbeat.
  const hashes=rows.rows.map(row=>row.tx_hash);let renewing:Promise<void>|null=null;
  const heartbeat=setInterval(()=>{
    if(renewing||!hashes.length)return;
    renewing=database.query(`UPDATE node_trace_jobs SET lease_until=clock_timestamp()+interval '10 seconds'
      WHERE lease_id=$1 AND tx_hash=ANY($2::text[]) AND lease_until>clock_timestamp()`,[lease,hashes])
      .then(()=>undefined,()=>undefined).finally(()=>{renewing=null;});
  },2_000);
  heartbeat.unref();
  try{
  for (const row of rows.rows) {
    try {
      const result = await (options.trace ?? traceNodeTransaction)(row.tx_hash, { ipcPath: options.ipcPath });
      if (!result) throw new Error('node_trace_unavailable');
      const trace=validateNodeTrace(result);
      const client: PoolClient = await database.connect();
      try {
        await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
        const active=(await client.query(`SELECT e.transaction FROM node_trace_jobs j JOIN node_evidence_transactions e ON e.tx_hash=j.tx_hash AND e.block_hash=j.block_hash
          JOIN node_evidence_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash
          WHERE j.tx_hash=$1 AND j.block_hash=$2 AND j.lease_id=$3 AND j.lease_until>clock_timestamp() FOR UPDATE OF j`,[row.tx_hash,row.block_hash,lease])).rows[0];
        if(!active)throw new Error('node_trace_evidence_changed');
        if(!nodeTraceMatchesTransaction(trace,active.transaction))throw new Error('node_trace_root_mismatch');
        const pairs=(await client.query(`SELECT DISTINCT e.wallet_address,f.token_address FROM node_executions e
          JOIN node_execution_flows f ON f.execution_id=e.id WHERE e.tx_hash=$1 AND e.block_hash=$2 ORDER BY e.wallet_address,f.token_address`,[row.tx_hash,row.block_hash])).rows;
        for(const pair of pairs)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`node-accounting:${pair.wallet_address}:${pair.token_address}`]);
        const saved=await client.query(`INSERT INTO node_trace_evidence(tx_hash,block_hash,trace,checked_at) SELECT tx_hash,block_hash,$3::jsonb,clock_timestamp() FROM node_evidence_transactions
          WHERE tx_hash=$1 AND block_hash=$2 ON CONFLICT(tx_hash) DO UPDATE SET trace=EXCLUDED.trace,checked_at=clock_timestamp()
          WHERE node_trace_evidence.block_hash=EXCLUDED.block_hash AND node_trace_evidence.trace IS DISTINCT FROM EXCLUDED.trace`,
        [row.tx_hash, row.block_hash, JSON.stringify(trace)]);
        if(saved.rowCount)for(const table of ['node_accounting_history','node_accounting_snapshots','node_accounting_snapshot_versions'])
          await client.query(`UPDATE ${table} s SET invalidated_at=clock_timestamp()${table==='node_accounting_snapshots'?',last_valid=NULL':''}
            WHERE EXISTS(SELECT 1 FROM node_executions e JOIN node_execution_flows f ON f.execution_id=e.id
              WHERE e.tx_hash=$1 AND e.block_hash=$2 AND e.wallet_address=s.wallet_address AND f.token_address=s.token_address)`,[row.tx_hash,row.block_hash]);
        if(saved.rowCount)await client.query("UPDATE node_evidence_transactions SET projection_at=NULL,projection_reason='native_trace_captured' WHERE tx_hash=$1 AND block_hash=$2",[row.tx_hash,row.block_hash]);
        if(saved.rowCount)await invalidateNodeLeaderboardForWallets(client,pairs.map(pair=>pair.wallet_address));
        await client.query(`UPDATE node_trace_jobs SET state='done',last_error=NULL,completed_at=now(),lease_id=NULL,lease_until=NULL WHERE tx_hash=$1 AND lease_id=$2`,[row.tx_hash,lease]);
        await client.query('COMMIT'); captured++;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch(error) {
      unavailable++;
      const reason=error instanceof Error&&['node_trace_state_unavailable','node_trace_timeout','node_trace_response_too_large','node_trace_bounds_invalid','node_trace_evidence_changed','node_trace_root_mismatch'].includes(error.message)?error.message:'node_trace_unavailable';
      await database.query(`UPDATE node_trace_jobs SET last_error=$3,next_attempt_at=now()+$4*interval '1 millisecond',
        state=CASE WHEN attempts>=6 AND $3 IN('node_trace_state_unavailable','node_trace_bounds_invalid','node_trace_response_too_large','node_trace_root_mismatch') THEN 'unavailable' ELSE 'pending' END,
        lease_id=NULL,lease_until=NULL WHERE tx_hash=$1 AND lease_id=$2`,[row.tx_hash,lease,reason,Math.min(600_000,5000*2**Math.min(7,row.attempts))]);
    }
  }
  return { captured, unavailable };
  }finally{clearInterval(heartbeat);if(renewing)await renewing;}
  }finally{try{if(locked)await coordinator.query('SELECT pg_advisory_unlock(782347)');}finally{coordinator.release();}}
}
