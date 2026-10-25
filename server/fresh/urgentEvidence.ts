import{freshSignedSelfCallBatch,FRESH_SELF_CALL_DELEGATE}from'./signedSelfCallSettlement.js';
import{readFreshSelfCallContext,persistFreshSelfCallContext}from'./selfCallContext.js';
import { createHash } from 'node:crypto';
import { Interface } from 'ethers';
import type { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import { transferTopic } from '../swap.js';
import { WBNB } from '../launchpad.js';
import { decodeFreshEvidence, encodeFreshEvidence, freshAddress, freshInteger, type FreshCapturedReceipt } from './capture.js';
import { createFreshStateEvidenceRpc, type FreshStateReadEvidence } from './stateEvidence.js';
import { freshCurrentQuote, freshQuoteUsd, type FreshPriceBlock } from './pricing.js';
import {readFreshV4MarketIdentities} from './v4Discovery.js';
import{createFreshCurrentMarketCanonicalHash}from'./currentMarketAnchor.js';
import{readFreshTokenAdmission}from'./tracking.js';

export const FRESH_URGENT_EVIDENCE_WINDOW_MS = 45_000;
export const FRESH_URGENT_EVIDENCE_MAX_RPC = 80;
export const FRESH_URGENT_EVIDENCE_MAX_PASS_MS = 8_000;
const abi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)']);
const directTokenAbi = new Interface(['function transfer(address to,uint256 amount)', 'function approve(address spender,uint256 amount)', 'function transferFrom(address from,address to,uint256 amount)']);
const topicAddress = (value: string | undefined) => value && /^0x0{24}[\da-f]{40}$/i.test(value) ? `0x${value.slice(-40).toLowerCase()}` : null;
const identity = (entry: FreshCapturedReceipt) => JSON.stringify({ transaction: entry.transaction, receipt: entry.receipt,
  wallets: [...entry.wallets].sort(), observedAt: entry.observedAt, historicalWallets: entry.historicalWallets });

/** Wallet flows come first, then intermediate assets actually present in this
 * transaction's transfers. No symbol, token row or public metadata provider
 * supplies historical precision. The cap also bounds malicious log spam. */
export function freshUrgentTokenTargets(entry: FreshCapturedReceipt, limit = 8) {
  const watched = new Set(entry.wallets), direct = new Set<string>(), intermediate = new Set<string>();
  // Standard exact token calls can pay attributable gas without Transfer logs,
  // including failed approvals/transfers. Arbitrary router calldata is not a
  // token identity and never adds its top-level recipient here.
  const recipient = freshAddress(entry.transaction.to), input = entry.transaction.input;
  if (recipient && watched.has(entry.transaction.from.toLowerCase()) && typeof input === 'string') try {
    const parsed = directTokenAbi.parseTransaction({ data: input });
    if (parsed && directTokenAbi.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() === input.toLowerCase()) direct.add(recipient);
  } catch { /* Unsupported calldata is not precision proof. */ }
  for (const log of entry.receipt.logs) {
    if (log.removed || log.topics[0]?.toLowerCase() !== transferTopic || log.topics.length !== 3
      || !/^0x[\da-f]{64}$/i.test(log.data) || !freshAddress(log.address)) continue;
    const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]);
    if (!from || !to) continue;
    (watched.has(from) || watched.has(to) ? direct : intermediate).add(log.address.toLowerCase());
  }
  return [...new Set([...direct, ...intermediate])].slice(0, Math.min(8, Math.max(1, limit)));
}

/** Merge only raw successes at this exact original receipt block. Work that
 * raced a recovery/diagnostic update keeps the latest envelope and its proofs;
 * contradictory call results fail closed instead of replacing either value. */
export function mergeFreshUrgentEvidence(selected: FreshCapturedReceipt, latest: FreshCapturedReceipt, proof: FreshStateReadEvidence) {
  if (identity(selected) !== identity(latest)) throw Error('urgent_receipt_context_changed');
  const block = { number: Number(freshInteger(latest.receipt.blockNumber)), hash: latest.receipt.blockHash.toLowerCase() };
  const prior = createFreshStateEvidenceRpc((async () => { throw Error('urgent_merge_no_rpc'); }) as Rpc, block, latest.stateEvidence);
  const incoming = createFreshStateEvidenceRpc((async () => { throw Error('urgent_merge_no_rpc'); }) as Rpc, block, proof);
  if (prior.rejectedPrior || incoming.rejectedPrior || !incoming.snapshot()) throw Error('urgent_state_evidence_invalid');
  const calls = new Map((prior.snapshot()?.calls ?? []).map(call => [`${call.to}:${call.data}`, call]));
  let changed = false;
  for (const call of incoming.snapshot()!.calls) {
    const key = `${call.to}:${call.data}`, existing = calls.get(key);
    if (existing && existing.result !== call.result) throw Error('urgent_state_evidence_conflict');
    if (!existing) { calls.set(key, call); changed = true; }
  }
  if (!changed) return null;
  const combined = { version: 1 as const, blockNumber: block.number, blockHash: block.hash, calls: [...calls.values()] };
  const checked = createFreshStateEvidenceRpc((async () => { throw Error('urgent_merge_no_rpc'); }) as Rpc, block, combined);
  if (checked.rejectedPrior) throw Error('urgent_state_evidence_capacity');
  return encodeFreshEvidence({ ...latest, stateEvidence: combined });
}

export async function persistFreshUrgentEvidence(database: Pool, selected: FreshCapturedReceipt, proof: FreshStateReadEvidence) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(73621941)');
    const number = Number(freshInteger(selected.receipt.blockNumber)), hash = selected.receipt.blockHash.toLowerCase();
    const canonical = (await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE', [number])).rows[0];
    if (canonical?.block_hash !== hash) { await client.query('ROLLBACK'); return false; }
    const row = (await client.query('SELECT payload,wallet_addresses FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR UPDATE', [selected.transaction.hash.toLowerCase(), hash])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return false; }
    const latest = decodeFreshEvidence(row.payload);
    if (!Array.isArray(row.wallet_addresses) || [...row.wallet_addresses].sort().join(',') !== [...latest.wallets].sort().join(',')) throw Error('urgent_wallet_context_changed');
    const payload = mergeFreshUrgentEvidence(selected, latest, proof);
    if (payload) await client.query('UPDATE fresh.recent_evidence SET payload=$3 WHERE tx_hash=$1 AND block_hash=$2', [selected.transaction.hash.toLowerCase(), hash, payload]);
    await client.query('COMMIT'); return Boolean(payload);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Independent of old repair normalization: protect the very short historical
 * state window first. This stage changes no financial events, jobs, collection
 * checkpoints or decode status. Successful proof remains in the existing 72h
 * envelope. RPC is always outside database transactions and concurrency is two. */
export function createFreshUrgentEvidenceCapture(database: Pool, nodeRpc: Rpc) {
  const attempted = new Map<string, { fingerprint: string; at: number }>();
  return async (options: { now?: Date; signal?: AbortSignal; limit?: number } = {}) => {
    const started = performance.now(), now = options.now ?? new Date(), selected = await database.query(`SELECT e.payload,e.tx_hash,e.block_hash,e.block_number,b.occurred_at
      FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash)
      WHERE e.decoder_status IN('pending','repair') AND b.occurred_at>=$1 AND b.occurred_at<=$2
      ORDER BY e.block_number DESC,e.transaction_index DESC,e.tx_hash LIMIT $3`,
    [new Date(now.getTime() - FRESH_URGENT_EVIDENCE_WINDOW_MS), new Date(now.getTime() + 5_000), 32]);
    const blockTimes = new Map(selected.rows.map(row => [row.block_hash, new Date(row.occurred_at).getTime()]));
    let contextChoice:{hash:string;number:number;wallet:string;tx:string}|undefined;
    const withinWindow = (params: unknown[],method='eth_call') => {
      const elapsed = Math.max(0, performance.now() - started), requestBlock = params[1] as { blockHash?: string } | undefined;
      const hash=method==='eth_getBlockByNumber'&&contextChoice&&params[0]==='0x'+contextChoice.number.toString(16)&&params[1]===true?contextChoice.hash:requestBlock?.blockHash;
      const time = hash ? blockTimes.get(hash) : undefined;
      return elapsed <= FRESH_URGENT_EVIDENCE_MAX_PASS_MS && time !== undefined
        && time >= now.getTime() + elapsed - FRESH_URGENT_EVIDENCE_WINDOW_MS && time <= now.getTime() + elapsed + 5_000;
    };
    for (const [key, value] of attempted) if (now.getTime() - value.at > 60_000) attempted.delete(key);
    while (attempted.size > 512) attempted.delete(attempted.keys().next().value!);
    let rpcCalls = 0, saved = 0, receipts = 0, unavailable = 0;
    // Coalesce exact requests only within this bounded pass. Each receipt still
    // retains the raw values it used, including shared feed/quote observations.
    const wire = new Map<string, Promise<unknown>>();
    let active = 0;
    const waiters: (() => void)[] = [];
    const boundedRpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
      if (options.signal?.aborted) throw Error('urgent_evidence_aborted');
      const contextAllowed=contextChoice&&(method==='eth_getBlockByNumber'&&params.length===2&&params[0]==='0x'+contextChoice.number.toString(16)&&params[1]===true||method==='eth_getCode'&&params.length===2&&[contextChoice.wallet,FRESH_SELF_CALL_DELEGATE].includes(String(params[0]))&&Object.keys((params[1]as any)??{}).sort().join(',')==='blockHash,requireCanonical'&&(params[1]as any)?.blockHash===contextChoice.hash&&(params[1]as any)?.requireCanonical===true);
      if (method !== 'eth_call'&&!contextAllowed || !withinWindow(params,method)) throw Error('urgent_evidence_window_expired');
      const key = JSON.stringify([method, params]);
      let pending = wire.get(key);
      if (!pending) {
        if (rpcCalls >= FRESH_URGENT_EVIDENCE_MAX_RPC) throw Error('urgent_evidence_rpc_budget');
        rpcCalls++;
        pending = (async () => {
          if (active >= 2) await new Promise<void>(resolve => waiters.push(resolve));
          else active++;
          try {
            if (options.signal?.aborted) throw Error('urgent_evidence_aborted');
            // Recheck after waiting for a bounded wire slot. Slow earlier reads
            // cannot start another historical request after its state expires.
            if (!withinWindow(params,method)) throw Error('urgent_evidence_window_expired');
            return await nodeRpc<unknown>(method, params);
          }
          finally { const next = waiters.shift(); if (next) next(); else active--; }
        })();
        wire.set(key, pending);
      }
      return await pending as T;
    };
    const rows = selected.rows.filter(row => {
      const key = `${row.tx_hash}:${row.block_hash}`, fingerprint = createHash('sha256').update(row.payload).digest('hex'), prior = attempted.get(key);
      if (prior && prior.fingerprint === fingerprint && now.getTime() - prior.at < 5_000) return false;
      return true;
    }).slice(0, Math.min(8, Math.max(1, options.limit ?? 4)));
    for (const row of rows) attempted.set(`${row.tx_hash}:${row.block_hash}`, { fingerprint: createHash('sha256').update(row.payload).digest('hex'), at: now.getTime() });
    // One exact signed self-call context receives priority before old optional
    // market work. The existing shared80-call/2-wire/8s-start limits still apply.
    const contextRow=rows.find(row=>{const entry=decodeFreshEvidence(row.payload);return entry.selfCallContext?.status!=='complete'&&Boolean(freshSignedSelfCallBatch(entry));});
    if(contextRow){const entry=decodeFreshEvidence(contextRow.payload),block:FreshPriceBlock={number:Number(contextRow.block_number),hash:contextRow.block_hash,timestamp:new Date(contextRow.occurred_at).toISOString()},wallet=entry.transaction.from;
      const active=(await database.query('SELECT active,revision,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE address=$1',[wallet])).rows[0];
      if(active?.active&&Number(active.monitoring_from_block)<=block.number&&(active.monitoring_to_block===null||Number(active.monitoring_to_block)>=block.number)){
        contextChoice={hash:block.hash,number:block.number,wallet,tx:entry.transaction.hash};
        await readFreshSelfCallContext(entry,block,boundedRpc,{signal:options.signal,now:()=>performance.now(),deadline:started+FRESH_URGENT_EVIDENCE_MAX_PASS_MS,
          save:async context=>{if(await persistFreshSelfCallContext(database,entry,context,String(active.revision)))saved++;}}).catch(()=>{unavailable++;return null;});
      }
    }
    const optional: (() => Promise<void>)[] = [];
    const metadataResults = await Promise.allSettled(rows.map(async row => {
      const entry = decodeFreshEvidence(row.payload), block: FreshPriceBlock = { number: Number(row.block_number), hash: row.block_hash, timestamp: new Date(row.occurred_at).toISOString() };
      if (Number(freshInteger(entry.receipt.blockNumber)) !== block.number || entry.receipt.blockHash.toLowerCase() !== block.hash
        || entry.transaction.hash.toLowerCase() !== row.tx_hash || entry.transaction.blockHash.toLowerCase() !== block.hash) throw Error('urgent_receipt_identity_invalid');
      const state = createFreshStateEvidenceRpc(boundedRpc, block, entry.stateEvidence), targets = freshUrgentTokenTargets(entry);
      let flushed = 0, chain: Promise<void> = Promise.resolve();
      // Each successful metadata sibling schedules its own durable flush; a
      // slow or failed sibling cannot hold the successful value in memory.
      const flush = () => {
        chain = chain.then(async () => {
          if (state.writes === flushed) return;
          const count = state.writes, proof = state.snapshot();
          if (proof && await persistFreshUrgentEvidence(database, entry, proof)) saved++;
          flushed = count;
        });
        return chain;
      };
      const savingRpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
        const result = await state.rpc<T>(method, params);
        if (state.writes > flushed) await flush();
        return result;
      };
      receipts++;
      // Quantity/supply is urgent; names/artwork are optional and stay in their
      // ordinary stages. Capture intermediate raw precision for routed swaps.
      for (const token of targets) await Promise.allSettled(['decimals', 'totalSupply'].map(method => savingRpc('eth_call', [{ to: token, data: abi.encodeFunctionData(method) }, { blockHash: block.hash, requireCanonical: true }])));
      await freshQuoteUsd(WBNB, { rpc: savingRpc, block }).catch(() => { unavailable++; });
      await state.settle(); await flush();
      optional.push(async () => {
        if (options.signal?.aborted || performance.now() - started > FRESH_URGENT_EVIDENCE_MAX_PASS_MS) return;
        const admitted=await Promise.all([...targets].sort().map(async token=>({token,admission:await readFreshTokenAdmission(database,token,{blockNumber:block.number})})));
        const eligible=admitted.find(candidate=>candidate.admission!==null);
        // Optional valuation starts only after every selected receipt's urgent
        // metadata/feed work has settled and successful siblings are durable.
        if (eligible && !options.signal?.aborted) {
          const marketIdentities=(await readFreshV4MarketIdentities(database,[eligible.token])).get(eligible.token);
          const canonicalHash=createFreshCurrentMarketCanonicalHash(database,{token:eligible.token,block});
          await freshCurrentQuote(eligible.token, { rpc: savingRpc, block, launchFact: eligible.admission?.kind==='new_launch'?eligible.admission.fact:undefined,marketIdentities,canonicalHash }).catch(() => { unavailable++; });
        }
        await state.settle(); await flush();
      });
    }));
    const failure = metadataResults.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const quoteResults = await Promise.allSettled(optional.map(run => run()));
    const quoteFailure = quoteResults.find(result => result.status === 'rejected');
    if (quoteFailure?.status === 'rejected') throw quoteFailure.reason;
    return { receipts, saved, rpcCalls, unavailable };
  };
}
