import { describe, expect, it,vi } from 'vitest';
import { Interface } from 'ethers';
import { transferTopic } from '../swap.js';
import { WBNB } from '../launchpad.js';
import { beforeExecutionTopic, userOperationTopic } from '../smartAccountTrades.js';
import { FRESH_ENTRY_POINTS,decodeFreshEvidence,encodeFreshEvidence, type FreshCapturedReceipt, type FreshLog } from './capture.js';
import { decodeFreshExecutions, normalizeFreshReceipt,recoverFreshRetainedTradeQuotes, preserveFreshVerifiedValuations,queueFreshDecodeRepair,freshDecodedEvidencePayload,finishFreshDecodedReceipt,assertFreshDecodeEvidenceUnchanged,reconcileFreshDecodeEvidence,canRecoverFreshMetadata, type FreshDecodeServices } from './decode.js';
import { freshNativeDelta, freshTraceMatchesTransaction } from './trace.js';
import {FreshMetadataReadError} from './pricing.js';
import {RpcRequestError} from '../rpc.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import type {Rpc} from '../rpc.js';

const address = (digit: string) => `0x${digit.repeat(40)}`, hash = (digit: string) => `0x${digit.repeat(64)}`, word = (value: string | bigint) => typeof value === 'bigint' ? value.toString(16).padStart(64, '0') : value.slice(2).padStart(64, '0');
const wallet = address('1'), other = address('2'), token = address('7'), quote = '0x55d398326f99059ff775485246999027b3197955';
const swap = new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const erc20 = new Interface(['function transfer(address to,uint256 amount)', 'function approve(address spender,uint256 amount)', 'function transferFrom(address from,address to,uint256 amount)']);
const block = { number: '0x65', hash: hash('a'), timestamp: '0x69000000' };
function log(address: string, topics: string[], data: string, index: number): FreshLog { return { address, topics, data, logIndex: `0x${index.toString(16)}`, transactionHash: hash('b'), transactionIndex: '0x0', blockNumber: block.number, blockHash: block.hash }; }
function transfer(token: string, from: string, to: string, raw: bigint, index: number) { return log(token, [transferTopic, `0x${word(from)}`, `0x${word(to)}`], `0x${word(raw)}`, index); }
function fixture(logs: FreshLog[]): FreshCapturedReceipt { return { transaction: { hash: hash('b'), from: wallet, to: other, value: '0x0', blockHash: block.hash, blockNumber: block.number, transactionIndex: '0x0', gasPrice: '0x3b9aca00' },
  receipt: { transactionHash: hash('b'), transactionIndex: '0x0', blockHash: block.hash, blockNumber: block.number, status: '0x1', gasUsed: '0x186a0', effectiveGasPrice: '0x3b9aca00', logs }, wallets: [wallet], observedAt: '2026-10-21T18:00:00Z' }; }
function services(): FreshDecodeServices { return { async metadata(address) { return { address, name: 'Fresh Token', symbol: 'NEW', decimals: 18, supplyRaw: '1000000000000000000000000', block: { number: 101, hash: block.hash, timestamp: '2026-10-21T18:00:00Z' } }; }, async eligible(value) { return value.address === token; }, async priceUsd(address) { return address === WBNB ? '600' : address === quote ? '1' : '3'; } }; }
function swapLog(index: number) { const value = swap.encodeEventLog('Swap', [other, 100n, 0n, 0n, 10n, wallet]); return log(other, value.topics, value.data, index); }
describe('fresh exact execution normalization', () => {
  it('commits agreeing additive urgent reads without losing concurrently saved raw proof or its own successful normalization reads',async()=>{
    const metadataAbi=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)']);
    const entry=fixture([]),firstFailure={version:1 as const,at:entry.observedAt,reasons:['token_decimals_unavailable']};
    entry.decodeDiagnostics={version:1,valuationReasons:['token_decimals_unavailable'],firstFailure};
    entry.stateEvidence={version:1,blockNumber:101,blockHash:block.hash,calls:[{to:token,data:metadataAbi.encodeFunctionData('decimals'),result:metadataAbi.encodeFunctionResult('decimals',[18])}]};
    const payload=encodeFreshEvidence(entry),rpc=vi.fn(async()=>metadataAbi.encodeFunctionResult('totalSupply',[123]))as unknown as Rpc;
    const state=createFreshStateEvidenceRpc(rpc,{number:101,hash:block.hash},entry.stateEvidence);
    await state.rpc('eth_call',[{to:token,data:metadataAbi.encodeFunctionData('totalSupply')},{blockHash:block.hash,requireCanonical:true}]);
    const latest=structuredClone(entry);latest.stateEvidence!.calls.push({to:other,data:metadataAbi.encodeFunctionData('decimals'),result:metadataAbi.encodeFunctionResult('decimals',[6])});
    const result=reconcileFreshDecodeEvidence({wallet_addresses:[wallet],payload:encodeFreshEvidence(latest)},{payload},entry,state);
    expect(result.merged).toBe(true);expect(result.entry.decodeDiagnostics?.firstFailure).toEqual(firstFailure);expect(result.state.snapshot()!.calls).toHaveLength(3);
    const saved=decodeFreshEvidence(freshDecodedEvidencePayload(result.entry,result.state)!);
    expect(saved.stateEvidence!.calls).toHaveLength(3);expect(saved.receipt).toEqual(entry.receipt);expect(saved.transaction).toEqual(entry.transaction);expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('uses already durable urgent additions without creating a redundant payload write',()=>{
    const entry=fixture([]),payload=encodeFreshEvidence(entry),state=createFreshStateEvidenceRpc(vi.fn()as unknown as Rpc,{number:101,hash:block.hash});
    const latest=structuredClone(entry);latest.stateEvidence={version:1,blockNumber:101,blockHash:block.hash,calls:[{to:token,data:'0x313ce567',result:`0x${'0'.repeat(62)}12`}]};
    const result=reconcileFreshDecodeEvidence({wallet_addresses:[wallet],payload:encodeFreshEvidence(latest)},{payload},entry,state);
    expect(result.merged).toBe(true);expect(freshDecodedEvidencePayload(result.entry,result.state)).toBeNull();expect(result.state.snapshot()).toEqual(latest.stateEvidence);
  });
  it('requires renormalization for concurrent membership, launch, recovery, trace or diagnostic changes',()=>{
    const entry=fixture([]),payload=encodeFreshEvidence(entry),state=createFreshStateEvidenceRpc(vi.fn()as unknown as Rpc,{number:101,hash:block.hash});
    for(const change of [
      {wallets:[other]}, {launchRepair:{version:1,kind:'stockwave',reason:'factory_creation_proof_invalid'}},
      {recoveryEvidence:{version:1,changed:'proof'}}, {trace:{changed:'trace'}}, {decodeDiagnostics:{version:1,valuationReasons:['changed']}}
    ]){
      const latest={...entry,...change}as FreshCapturedReceipt;
      expect(()=>reconcileFreshDecodeEvidence({wallet_addresses:[wallet],payload:encodeFreshEvidence(latest)},{payload},entry,state)).toThrow(/decode_evidence_changed/);
    }
    expect(()=>reconcileFreshDecodeEvidence({wallet_addresses:[other],payload},{payload},entry,state)).toThrow('decode_wallet_context_changed');
  });
  it('rejects deleted, altered, conflicting or foreign-block state proof instead of approving stale normalization',async()=>{
    const entry=fixture([]);entry.stateEvidence={version:1,blockNumber:101,blockHash:block.hash,calls:[{to:token,data:'0x313ce567',result:`0x${'0'.repeat(62)}12`}]};
    const payload=encodeFreshEvidence(entry),state=createFreshStateEvidenceRpc(vi.fn()as unknown as Rpc,{number:101,hash:block.hash},entry.stateEvidence);
    for(const proof of [undefined,{...entry.stateEvidence,blockHash:hash('c')},{...entry.stateEvidence,calls:[{...entry.stateEvidence.calls[0],result:`0x${'0'.repeat(63)}6`}]}]){
      const latest={...entry,stateEvidence:proof};
      expect(()=>reconcileFreshDecodeEvidence({wallet_addresses:[wallet],payload:encodeFreshEvidence(latest)},{payload},entry,state)).toThrow('decode_state_evidence_changed');
    }
    const empty=fixture([]),live=createFreshStateEvidenceRpc((async()=>`0x${'0'.repeat(63)}1`)as Rpc,{number:101,hash:block.hash});
    await live.rpc('eth_call',[{to:token,data:'0x313ce567'},{blockHash:block.hash,requireCanonical:true}]);
    const latest={...empty,stateEvidence:entry.stateEvidence};
    expect(()=>reconcileFreshDecodeEvidence({wallet_addresses:[wallet],payload:encodeFreshEvidence(latest)},{payload:encodeFreshEvidence(empty)},empty,live)).toThrow('decode_state_evidence_conflict');
  });
  it('permits verified metadata proof recovery during transport/cooldowns without treating invalid responses or reverts as missing history',()=>{
    for(const category of ['state_unavailable','transport','rate_limit'] as const){
      const error=new FreshMetadataReadError('decimals',new RpcRequestError('unavailable',category));
      expect(canRecoverFreshMetadata(error)).toBe(true);
    }
    for(const category of ['revert','invalid_response','rpc_error'] as const){
      const error=new FreshMetadataReadError('decimals',new RpcRequestError('unavailable',category));
      expect(canRecoverFreshMetadata(error)).toBe(false);
    }
    for(const error of [null,undefined,'transport',new Error('state_unavailable'),{category:'latest'},{}])expect(canRecoverFreshMetadata(error)).toBe(false);
  });
  it('rejects stale normalization after a concurrent receipt-proof repair without discarding the newer bytes',()=>{
    const prior=Buffer.from('original compressed evidence'),repaired=Buffer.from('original receipt plus reviewed launch recovery');
    expect(()=>assertFreshDecodeEvidenceUnchanged({wallet_addresses:[wallet,other],payload:Buffer.from(prior)},{payload:prior},[other,wallet])).not.toThrow();
    expect(()=>assertFreshDecodeEvidenceUnchanged({wallet_addresses:[wallet],payload:repaired},{payload:prior},[wallet])).toThrow('decode_evidence_changed');
    expect(repaired.toString()).toBe('original receipt plus reviewed launch recovery');
    expect(()=>assertFreshDecodeEvidenceUnchanged(undefined,{payload:prior},[wallet])).toThrow('decode_wallet_context_changed');
    expect(()=>assertFreshDecodeEvidenceUnchanged({wallet_addresses:[other],payload:prior},{payload:prior},[wallet])).toThrow('decode_wallet_context_changed');
  });
  it('preserves the original first failure after a genuine repair completes and its retry job is removed',async()=>{
    const entry=fixture([]),decoded={events:[],tokens:[],executions:1,reasons:[]},firstFailure={version:1,at:'2026-10-23T02:54:28.326Z',reasons:['trade_value_unavailable']};
    const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT progress')?{rows:[{progress:{firstFailure}}]}:{rows:[],rowCount:1});
    expect(await finishFreshDecodedReceipt({query}as any,{row:{tx_hash:entry.transaction.hash,block_hash:block.hash},entry,decoded,
      state:createFreshStateEvidenceRpc(vi.fn()as Rpc,{number:101,hash:block.hash}),now:new Date()})).toEqual({waiting:false,valuationOnly:false});
    const calls=query.mock.calls as unknown as [string,unknown[]][],update=calls.find(([sql])=>sql.startsWith('UPDATE fresh.recent_evidence'))!;
    expect(update[1].slice(2,5)).toEqual(['done',3,null]);expect(decodeFreshEvidence(update[1][5]as Buffer).decodeDiagnostics).toEqual({version:1,valuationReasons:[],firstFailure});
    expect(calls.some(([sql])=>sql.startsWith('DELETE FROM fresh.jobs'))).toBe(true);
  });
  it('finishes an untraded transfer with original first diagnostics and null value retained in its receipt',async()=>{
    const entry=fixture([transfer(token,other,wallet,5n*10n**18n,0)]);entry.transaction.from=other;
    const timestamp=new Date(Number(BigInt(block.timestamp))*1000).toISOString(),normal=services();
    const decoded=await normalizeFreshReceipt(entry,block,{...normal,async metadata(address){const value=await normal.metadata(address);return value&&{...value,block:{number:101,hash:block.hash,timestamp}};},async priceUsd(){return null;}});
    expect(decoded.reasons).toEqual(['incoming_transfer_cost_unknown']);expect(decoded.events[0]).toMatchObject({amountUsd:null,feeUsd:'0',quantity:'5'});
    const firstFailure={version:1,at:'2026-10-21T18:00:00.000Z',reasons:['token_decimals_unavailable']},calls:{sql:string;params:unknown[]}[]=[];
    const database={query:vi.fn(async(sql:string,params:unknown[]=[])=>{calls.push({sql,params});
      if(sql.startsWith('WITH candidates'))return{rows:[{has_trade:false}]};
      if(sql.startsWith('SELECT progress'))return{rows:[{progress:{firstFailure}}]};
      return{rows:[],rowCount:1};
    })} as any;
    const state=createFreshStateEvidenceRpc(vi.fn() as Rpc,{number:101,hash:block.hash}),row={tx_hash:entry.transaction.hash,block_hash:block.hash};
    expect(await finishFreshDecodedReceipt(database,{row,entry,decoded,state,now:new Date(timestamp)})).toEqual({waiting:false,valuationOnly:true});
    const update=calls.find(call=>call.sql.startsWith('UPDATE fresh.recent_evidence'))!;
    expect(update.params.slice(2,5)).toEqual(['done',3,'incoming_transfer_cost_unknown']);
    const retained=decodeFreshEvidence(update.params[5] as Buffer);
    expect(retained.transaction).toEqual(entry.transaction);expect(retained.receipt).toEqual(entry.receipt);
    expect(retained.decodeDiagnostics).toEqual({version:1,valuationReasons:['incoming_transfer_cost_unknown'],firstFailure});
    expect(decoded.events[0].amountUsd).toBeNull();
    expect(calls.filter(call=>call.sql.startsWith('DELETE'))).toEqual([{sql:"DELETE FROM fresh.jobs WHERE kind='decode_receipt' AND reference=$1",params:[`${row.tx_hash}:${row.block_hash}`]}]);
    expect(calls.some(call=>call.sql.startsWith('INSERT INTO fresh.jobs'))).toBe(false);
    // A later pass keeps the same original diagnostic even after the job is gone.
    database.query.mockImplementation(async(sql:string)=>sql.startsWith('WITH candidates')?{rows:[{has_trade:false}]}:{rows:[],rowCount:1});
    await finishFreshDecodedReceipt(database,{row,entry:retained,decoded,state,now:new Date(timestamp)});
    const lastUpdate=database.query.mock.calls.filter(([sql]:[string])=>sql.startsWith('UPDATE fresh.recent_evidence')).at(-1)!;
    expect(lastUpdate[1][5]).toBeNull();
  });
  it('does not turn a legacy unknown first cause into an invented diagnostic',async()=>{
    const entry=fixture([transfer(token,other,wallet,5n*10n**18n,0)]);entry.transaction.from=other;
    const timestamp=new Date(Number(BigInt(block.timestamp))*1000).toISOString(),normal=services();
    const decoded=await normalizeFreshReceipt(entry,block,{...normal,async metadata(address){const value=await normal.metadata(address);return value&&{...value,block:{number:101,hash:block.hash,timestamp}};},async priceUsd(){return null;}});
    const query=vi.fn(async(sql:string)=>sql.startsWith('WITH candidates')?{rows:[{has_trade:false}]}:sql.startsWith('SELECT progress')?{rows:[{progress:{}}]}:{rows:[],rowCount:1});
    await finishFreshDecodedReceipt({query} as any,{row:{tx_hash:entry.transaction.hash,block_hash:block.hash},entry,decoded,state:createFreshStateEvidenceRpc(vi.fn() as Rpc,{number:101,hash:block.hash}),now:new Date(timestamp)});
    const update=(query.mock.calls as unknown as [string,unknown[]][]).find(([sql])=>sql.startsWith('UPDATE fresh.recent_evidence'))!;
    expect(decodeFreshEvidence(update[1][5] as Buffer).decodeDiagnostics).toEqual({version:1,valuationReasons:['incoming_transfer_cost_unknown']});
  });
  it('keeps genuine decoding failures in repair with their existing first diagnostic',async()=>{
    const entry=fixture([]),decoded={events:[],tokens:[],executions:1,reasons:['token_decimals_unavailable']};
    const query=vi.fn(async()=>({rows:[],rowCount:1}));
    expect(await finishFreshDecodedReceipt({query} as any,{row:{tx_hash:entry.transaction.hash,block_hash:block.hash},entry,decoded,
      state:createFreshStateEvidenceRpc(vi.fn() as Rpc,{number:101,hash:block.hash}),now:new Date()})).toEqual({waiting:true,valuationOnly:false});
    const calls=query.mock.calls as unknown as [string,unknown[]][];
    expect(calls[0][1].slice(2,5)).toEqual(['repair',3,'token_decimals_unavailable']);
    expect(calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);expect(calls[1][0]).toContain('INSERT INTO fresh.jobs');
  });
  it('retains exact-block successful reads beside unchanged receipt facts across retries',async()=>{
    const entry=fixture([transfer(token,wallet,other,123n,0)]),rpc=vi.fn(async()=>`0x${word(18n)}`) as Rpc;
    const state=createFreshStateEvidenceRpc(rpc,{number:101,hash:block.hash});
    await state.rpc('eth_call',[{to:token,data:'0x313ce567'},{blockHash:block.hash,requireCanonical:true}]);await state.settle();
    const payload=freshDecodedEvidencePayload(entry,state)!;expect(payload).not.toBeNull();
    const saved=decodeFreshEvidence(payload),{stateEvidence,version:_version,...original}=saved as FreshCapturedReceipt&{version:1};expect(original).toEqual(entry);
    const unavailable=vi.fn(async()=>{throw new RpcRequestError('RPC eth_call unavailable','state_unavailable',{code:-32000});}) as Rpc;
    const reopened=createFreshStateEvidenceRpc(unavailable,{number:101,hash:block.hash},stateEvidence);
    expect(await reopened.rpc('eth_call',[{to:token,data:'0x313ce567'},{blockHash:block.hash,requireCanonical:true}])).toBe(`0x${word(18n)}`);
    expect(unavailable).not.toHaveBeenCalled();expect(freshDecodedEvidencePayload(saved,reopened)).toBeNull();
  });
  it('removes foreign block proofs without changing original receipt evidence',()=>{
    const entry={...fixture([]),stateEvidence:{version:1 as const,blockNumber:101,blockHash:hash('f'),calls:[{to:token,data:'0x313ce567',result:`0x${word(18n)}`}]}};
    const state=createFreshStateEvidenceRpc(vi.fn() as Rpc,{number:101,hash:block.hash},entry.stateEvidence);
    expect(state.rejectedPrior).toBe(true);const saved=decodeFreshEvidence(freshDecodedEvidencePayload(entry,state)!);
    expect(saved.stateEvidence).toBeUndefined();expect(saved.transaction).toEqual(entry.transaction);expect(saved.receipt).toEqual(entry.receipt);
  });
  it('records safe first diagnostics only on insert, preserving previous and unknown first causes',async()=>{
    const query=vi.fn(async()=>({rows:[],rowCount:1})),database={query} as any,at=new Date('2026-10-22T12:00:00Z');
    await queueFreshDecodeRepair(database,{tx_hash:hash('a'),block_hash:hash('b')},at,['token_decimals_unavailable','token_metadata_decimals_transport','https://private.invalid/secret']);
    const [sql,params]=query.mock.calls[0] as unknown as [string,unknown[]],progress=JSON.parse(params[5] as string);
    expect(progress).toEqual({firstFailure:{version:1,at:at.toISOString(),reasons:['token_decimals_unavailable','token_metadata_decimals_transport']}});
    expect(sql.split('ON CONFLICT')[1]).not.toMatch(/\bprogress\s*=/i);expect(JSON.stringify(progress)).not.toMatch(/private|secret|https/);
    expect(params[3]).toBe('token_decimals_unavailable,token_metadata_decimals_transport');
    await queueFreshDecodeRepair(database,{tx_hash:hash('a'),block_hash:hash('b')},new Date(at.getTime()+60_000),['token_metadata_decimals_state_unavailable_code_-32000']);
    expect((query.mock.calls[1] as unknown as [string,unknown[]])[0].split('ON CONFLICT')[1]).not.toMatch(/\bprogress\s*=/i);
  });
  it('preserves the compatibility repair reason plus a safe metadata field/category',async()=>{
    const value=fixture([transfer(token,other,wallet,10n*10n**18n,0)]);
    const decoded=await normalizeFreshReceipt(value,block,{...services(),async metadata(){throw new FreshMetadataReadError('total_supply',new RpcRequestError('RPC eth_call unavailable','state_unavailable',{code:-32000}));}});
    expect(decoded.events).toEqual([]);expect(decoded.reasons).toEqual(['token_decimals_unavailable','token_metadata_total_supply_state_unavailable_code_-32000']);
    const recovered=await normalizeFreshReceipt(value,block,services());expect(recovered.reasons).toEqual([]);expect(recovered.events).toHaveLength(1);
  });
  it('does not let diagnostics on an unallocated failed attempt change accounting eligibility',async()=>{
    const value=fixture([]);value.receipt.status='0x0';value.transaction.to=token;value.transaction.input=erc20.encodeFunctionData('approve',[other,10n]);
    const decoded=await normalizeFreshReceipt(value,block,{...services(),async metadata(){throw new FreshMetadataReadError('decimals',new RpcRequestError('RPC eth_call unavailable','state_unavailable',{code:-32000}));}});
    expect(decoded.reasons).toEqual([]);expect(decoded.events[0]).toMatchObject({kind:'fee',tokenAddress:null,feeAttribution:{status:'unattributed'}});
  });
  it('records exact quote-paid buys and attributable EOA gas once', async () => {
    const value = fixture([transfer(quote, wallet, other, 100n * 10n ** 18n, 0), transfer(token, other, wallet, 10n * 10n ** 18n, 1), swapLog(2)]);
    const decoded = await normalizeFreshReceipt(value, block, services()); expect(decoded.reasons).toEqual([]); expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({ kind: 'buy', quantity: '10', amountUsd: '100', feeUsd: '0.06', blockHash: block.hash,quoteAddress:quote,quoteSymbol:'USDT',quoteAmount:'100' });
    const retry = await normalizeFreshReceipt(value, block, services()); expect(retry.events).toEqual(decoded.events);
  });
  it('preserves a single raw unit of a 77-decimal token instead of converting it to zero', async () => {
    const value = fixture([transfer(token, other, wallet, 1n, 0)]), normal = services();
    const decoded = await normalizeFreshReceipt(value, block, { ...normal, async metadata(address) { const metadata = await normal.metadata(address); return metadata ? { ...metadata, decimals: 77 } : null; } });
    expect(decoded.events[0].quantity).toBe(`0.${'0'.repeat(76)}1`); expect(decoded.events[0].kind).toBe('transfer_in');
  });
  it('retains previously verified USD values on a temporary feed/trace retry gap', async () => {
    const value = fixture([transfer(quote, wallet, other, 100n * 10n ** 18n, 0), transfer(token, other, wallet, 10n * 10n ** 18n, 1), swapLog(2)]);
    const verified = await normalizeFreshReceipt(value, block, services()), retry = structuredClone(verified);
    retry.events[0].amountUsd = null; retry.events[0].feeUsd = null; retry.reasons = ['trade_value_unavailable', 'wallet_fee_valuation_unavailable'];
    preserveFreshVerifiedValuations(retry, new Map(verified.events.map(event => [event.id, event])));
    expect(retry.events).toEqual(verified.events); expect(retry.reasons).toEqual([]);
  });
  it('never carries old valuations across changed quantities or contradictory native evidence', async () => {
    const verified = await normalizeFreshReceipt(fixture([transfer(token, other, wallet, 10n * 10n ** 18n, 0)]), block, services());
    const previous = new Map(verified.events.map(event => [event.id, event]));
    const changed = structuredClone(verified); changed.events[0].quantity = '11'; changed.events[0].amountUsd = null; changed.events[0].feeUsd = null;
    changed.reasons = ['incoming_transfer_cost_unknown', 'wallet_fee_valuation_unavailable']; preserveFreshVerifiedValuations(changed, previous);
    expect(changed.events[0].amountUsd).toBeNull(); expect(changed.events[0].feeUsd).toBeNull(); expect(changed.reasons).toHaveLength(2);
    const contradiction = structuredClone(verified); contradiction.events[0].amountUsd = null; contradiction.events[0].feeUsd = null; contradiction.reasons = ['native_payout_mismatch', 'incoming_transfer_cost_unknown'];
    preserveFreshVerifiedValuations(contradiction, previous); expect(contradiction.events[0].amountUsd).toBeNull(); expect(contradiction.events[0].feeUsd).toBeNull(); expect(contradiction.reasons).toContain('native_payout_mismatch');
  });
  it('retains transfer pairs with original log identity and never charges recipient gas', async () => {
    const value = fixture([transfer(token, wallet, other, 4n * 10n ** 18n, 0)]); value.wallets.push(other);
    const decoded = await normalizeFreshReceipt(value, block, services()); expect(decoded.events).toHaveLength(2);
    const out = decoded.events.find(event => event.kind === 'transfer_out')!, incoming = decoded.events.find(event => event.kind === 'transfer_in')!;
    expect(out.transferKey).toBe(incoming.transferKey); expect(incoming.feeUsd).toBe('0'); expect(out.feeUsd).toBe('0.06'); expect(out.amountUsd).toBe('12');
  });
  it('keeps execution identity stable when another wallet starts monitoring the same receipt', async () => {
    const value = fixture([transfer(token, wallet, other, 4n * 10n ** 18n, 0)]); value.wallets = [other];
    const before = await normalizeFreshReceipt(value, block, services()); value.wallets = [wallet, other];
    const after = await normalizeFreshReceipt(value, block, services());
    expect(after.events.find(event => event.walletAddress === other)).toEqual(before.events[0]);
  });
  it('does not create a purchase lot for a self transfer and retains the authenticated gas', async () => {
    const decoded = await normalizeFreshReceipt(fixture([transfer(token, wallet, wallet, 4n * 10n ** 18n, 0)]), block, services());
    expect(decoded.reasons).toEqual([]); expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({ kind: 'fee', tokenAddress: token, quantity: '0', amountUsd: '0', feeUsd: '0.06', feeAttribution: { status: 'eligible', tokenAddress: token, nativeFeeWei: '100000000000000' } });
  });
  it('uses canonical operation order independently of which smart accounts are monitored', async () => {
    const ep = FRESH_ENTRY_POINTS[0], value = fixture([]); value.transaction.from = address('3'); value.transaction.to = ep;
    const operation = (sender: string, id: string, index: number) => log(ep, [userOperationTopic, hash(id), `0x${word(sender)}`, `0x${'0'.repeat(64)}`], `0x${word(1n)}${word(1n)}${word(100_000_000_000_000n)}${word(100_000n)}`, index);
    value.wallets = [other]; value.receipt.logs = [log(ep, [beforeExecutionTopic], '0x', 0), transfer(token, address('3'), wallet, 1n, 1), operation(wallet, 'c', 2), transfer(token, address('3'), other, 2n, 3), operation(other, 'd', 4)];
    const before = await normalizeFreshReceipt(value, block, services()); value.wallets = [wallet, other];
    const after = await normalizeFreshReceipt(value, block, services());
    expect(after.events.find(event => event.walletAddress === other)).toEqual(before.events[0]);
    expect(before.events[0].executionIndex).toBe(2);
  });
  it('uses null for missing native payout/trace or unknown purchase cost', async () => {
    const value = fixture([transfer(token, other, wallet, 10n * 10n ** 18n, 0), swapLog(1)]); value.transaction.value = '0xde0b6b3a7640000';
    const decoded = await normalizeFreshReceipt(value, block, services()); expect(decoded.events[0].amountUsd).toBeNull(); expect(decoded.reasons).toContain('trade_value_unavailable');
    expect(decoded.events[0].quoteAmount).toBeUndefined();
    const unknown = await normalizeFreshReceipt(fixture([transfer(token, other, wallet, 10n, 0)]), block, { ...services(), async priceUsd() { return null; } });
    expect(unknown.reasons).toContain('incoming_transfer_cost_unknown'); expect(unknown.events[0].amountUsd).toBeNull();
  });
  it('excludes before-boundary/unverified tokens without fabricating eligibility', async () => {
    const decoded = await normalizeFreshReceipt(fixture([transfer(token, other, wallet, 10n, 0)]), block, { ...services(), async eligible() { return false; } }); expect(decoded.events).toEqual([]);
  });
  it.each(FRESH_ENTRY_POINTS)('preserves repeated smart-account operations and authenticated fees at %s', async ep => {
    const value = fixture([]); value.transaction.from = other; value.transaction.to = ep;
    const operation = (id: string, index: number) => log(ep, [userOperationTopic, hash(id), `0x${word(wallet)}`, `0x${'0'.repeat(64)}`], `0x${word(1n)}${word(1n)}${word(100_000_000_000_000n)}${word(100_000n)}`, index);
    value.receipt.logs = [log(ep, [beforeExecutionTopic], '0x', 0), transfer(quote, wallet, other, 100n * 10n ** 18n, 1), transfer(token, other, wallet, 10n * 10n ** 18n, 2), swapLog(3), operation('c', 4), transfer(quote, wallet, other, 20n * 10n ** 18n, 5), transfer(token, other, wallet, 2n * 10n ** 18n, 6), swapLog(7), operation('d', 8)];
    const executions = decodeFreshExecutions(value); expect(executions).toHaveLength(2); expect(executions[0].operationHash).not.toBe(executions[1].operationHash);
    const decoded = await normalizeFreshReceipt(value, block, services()); expect(decoded.events.map(event => event.quantity)).toEqual(['10', '2']); expect(decoded.events.map(event => event.feeUsd)).toEqual(['0.06', '0.06']);
    expect(new Set(decoded.events.map(event => event.executionKey)).size).toBe(2);
  });
  it('keeps unsupported future EntryPoint/sponsored operations explicit instead of converting them to free transfers', async () => {
    const ep = address('f'), value = fixture([]); value.transaction.from = other; value.transaction.to = ep;
    value.receipt.logs = [log(ep, [beforeExecutionTopic], '0x', 0), transfer(token, other, wallet, 10n, 1),
      log(ep, [userOperationTopic, hash('c'), `0x${word(wallet)}`, `0x${'0'.repeat(64)}`], `0x${word(1n)}${word(1n)}${word(10n)}${word(1n)}`, 2)];
    const decoded = await normalizeFreshReceipt(value, block, services()); expect(decoded.events).toEqual([]); expect(decoded.reasons).toContain('unsupported_smart_account_operation');
    const known = FRESH_ENTRY_POINTS[0]; value.transaction.to = known; value.receipt.logs.forEach(item => { if (item.address === ep) item.address = known; });
    value.receipt.logs[2].topics[3] = `0x${word(other)}`;
    const sponsored = await normalizeFreshReceipt(value, block, services()); expect(sponsored.events).toEqual([]); expect(sponsored.reasons).toContain('unsupported_smart_account_operation');
  });
  it('reuses retained verified native traces without another trace request', async () => {
    const value = fixture([transfer(token, other, wallet, 10n * 10n ** 18n, 0), swapLog(1)]); value.transaction.value = '0xde0b6b3a7640000';
    value.trace = { type: 'CALL', from: wallet, to: other, value: value.transaction.value };
    const decoded = await normalizeFreshReceipt(value, block, { ...services(), async trace() { throw new Error('must_reuse_evidence'); } });
    expect(decoded.events[0]).toMatchObject({amountUsd:'600',quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:'1'}); expect(decoded.reasons).toEqual([]);
  });
  it('retains exact native settlement after a refund even while its USD value or fee is unknown',async()=>{
    const value=fixture([transfer(token,other,wallet,10n*10n**18n,0),swapLog(1)]);value.transaction.value='0xde0b6b3a7640000';
    value.trace={type:'CALL',from:wallet,to:other,value:value.transaction.value,calls:[{type:'CALL',from:other,to:wallet,value:'0x16345785d8a0000'}]};
    const decoded=await normalizeFreshReceipt(value,block,{...services(),async priceUsd(){return null;}});
    expect(decoded.events[0]).toMatchObject({amountUsd:null,feeUsd:null,quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:'0.9'});
    expect(decoded.reasons).toContain('trade_value_unavailable');expect(decoded.reasons).toContain('wallet_fee_valuation_unavailable');
  });
  it('keeps actual wrapped-native and stablecoin transfers separate from native BNB and unknown USD',async()=>{
    for(const asset of[WBNB,quote]){
      const value=fixture([transfer(asset,wallet,other,100n*10n**18n,0),transfer(token,other,wallet,10n*10n**18n,1),swapLog(2)]);
      const decoded=await normalizeFreshReceipt(value,block,{...services(),async priceUsd(){return null;}});
      expect(decoded.events[0]).toMatchObject({amountUsd:null,quoteAddress:asset,quoteSymbol:asset===WBNB?'WBNB':'USDT',quoteAmount:'100'});
    }
  });
  it('does not assign an entire quote payment to one token when another untracked asset changes',async()=>{
    const value=fixture([transfer(quote,wallet,other,100n*10n**18n,0),transfer(token,other,wallet,10n*10n**18n,1),transfer(address('9'),other,wallet,1n,2),swapLog(3)]);
    const decoded=await normalizeFreshReceipt(value,block,services());expect(decoded.events[0].quoteAmount).toBeUndefined();
  });
  it('adds quote display to retained USD only from original precision without new metadata or USD requests',async()=>{
    for(const captured of[false,true]){
      const value=fixture([transfer(quote,wallet,other,100n*10n**6n,0),transfer(token,other,wallet,10n*10n**18n,1),swapLog(2)]);
      if(captured)value.stateEvidence={version:1,blockNumber:101,blockHash:block.hash,calls:[{to:quote,data:'0x313ce567',result:'0x'+word(6n)}]};
      const base=services(),unneededMetadata=vi.fn(async()=>{throw Error('no_new_quote_metadata');}),unneededPrice=vi.fn(async()=>{throw Error('no_new_quote_price');});
      const decoded=await normalizeFreshReceipt(value,block,{...base,metadata:address=>address===token?base.metadata(address):unneededMetadata(),
        priceUsd:address=>address===WBNB?base.priceUsd(address):unneededPrice(),quotePaymentUsd:async()=> '60000'});
      expect(decoded.events[0].amountUsd).toBe('60000');expect(unneededMetadata).not.toHaveBeenCalled();expect(unneededPrice).not.toHaveBeenCalled();
      if(captured)expect(decoded.events[0]).toMatchObject({quoteAddress:quote,quoteSymbol:'USDT',quoteAmount:'100'});
      else expect(decoded.events[0].quoteAmount).toBeUndefined();
    }
  });
  it('preserves verified quote proof on transient retries and rejects conflicting settled values',async()=>{
    const value=fixture([transfer(quote,wallet,other,100n*10n**18n,0),transfer(token,other,wallet,10n*10n**18n,1),swapLog(2)]);
    const verified=await normalizeFreshReceipt(value,block,services()),saved=new Map(verified.events.map(event=>[event.id,event]));
    const retry=structuredClone(verified);delete retry.events[0].quoteAddress;delete retry.events[0].quoteSymbol;delete retry.events[0].quoteAmount;
    preserveFreshVerifiedValuations(retry,saved);expect(retry.events).toEqual(verified.events);
    const conflict=structuredClone(verified);conflict.events[0].quoteAmount='101';
    expect(()=>preserveFreshVerifiedValuations(conflict,saved)).toThrow('conflicting_trade_quote_evidence');
  });
  it('previews retained quote enrichment without RPC or altering any original USD/fee/identity field',async()=>{
    const value=fixture([transfer(token,other,wallet,10n*10n**18n,0),swapLog(1)]);value.transaction.value='0xde0b6b3a7640000';
    value.transaction.type='0x2';
    value.trace={type:'CALL',from:wallet,to:other,value:value.transaction.value};
    value.stateEvidence={version:1,blockNumber:101,blockHash:block.hash,calls:[{to:token,data:'0x313ce567',result:'0x'+word(18n)}]};
    const decoded=await normalizeFreshReceipt(value,block,services()),events=decoded.events.map(event=>{const{quoteAddress,quoteSymbol,quoteAmount,...original}=event;return original;});
    const target={number:101,hash:block.hash,timestamp:events[0].occurredAt},preview=await recoverFreshRetainedTradeQuotes(value,target,events);
    expect(preview.rpcRequests).toBe(0);expect(preview.providerRequests).toBe(0);expect(preview.events).toHaveLength(1);
    expect(preview.events[0]).toEqual({...events[0],quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:'1'});
    expect((await recoverFreshRetainedTradeQuotes(value,target,[{...events[0],quantity:'11'}])).events).toEqual([]);
    await expect(recoverFreshRetainedTradeQuotes(value,target,[{...events[0],blockHash:hash('c')}])).rejects.toThrow('trade_quote_recovery_context');
    await expect(recoverFreshRetainedTradeQuotes(value,target,[{...events[0],canonical:false}])).rejects.toThrow('trade_quote_recovery_context');
    // Wei is intrinsic native precision. Previously canonical token quantity
    // stays unchanged; missing token decimals does not hide native payment.
    const{stateEvidence,...noPrecision}=value;expect((await recoverFreshRetainedTradeQuotes(noPrecision,target,events)).events).toEqual(preview.events);
    expect((await recoverFreshRetainedTradeQuotes({...noPrecision,transaction:{...noPrecision.transaction,type:'0x4'}},target,events)).events).toEqual([]);
    expect((await recoverFreshRetainedTradeQuotes(noPrecision,target,[events[0],{...events[0],id:events[0].id+':extra'}])).events).toEqual([]);
    await expect(recoverFreshRetainedTradeQuotes({...value,trace:{...value.trace,from:other}},target,events)).rejects.toThrow('trade_quote_recovery_trace');
  });
  it('does not replace a complete full-refund trace with a gross router payment event',async()=>{
    const router='0x1de460f363af910f51726def188f9004276bf4bc',raw=200n;
    const payment=log(router,['0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a','0x'+word(wallet),'0x'+word(wallet),'0x'+word(0n)],
      '0x'+[100n,raw,96n,1n,32n,7n,0n,token,router,0n,0n,0n,320n,0n,0n,0n].map(word).join(''),1);
    const value=fixture([transfer(token,router,wallet,raw,0),payment]);value.transaction.to=router;value.transaction.value='0x64';
    value.trace={type:'CALL',from:wallet,to:router,value:'0x64',calls:[{type:'CALL',from:router,to:wallet,value:'0x64'}]};
    const decoded=await normalizeFreshReceipt(value,block,services());expect(decoded.events[0].amountUsd).toBeNull();expect(decoded.events[0].quoteAmount).toBeUndefined();expect(decoded.reasons).toContain('native_payout_mismatch');
  });
  it('does not label gross native debit as one token quote when real non-native change returns',async()=>{
    const value=fixture([transfer(token,other,wallet,10n*10n**18n,0),transfer(address('9'),other,wallet,1n,1),swapLog(2)]);value.transaction.value='0xde0b6b3a7640000';
    value.trace={type:'CALL',from:wallet,to:other,value:value.transaction.value};
    const decoded=await normalizeFreshReceipt(value,block,services());expect(decoded.events[0].quoteAmount).toBeUndefined();expect(decoded.events[0].amountUsd).toBeNull();
  });
  it('charges a successful exact token approval once without inventing a trade',async()=>{
    const value=fixture([]);value.transaction.to=token;value.transaction.input=erc20.encodeFunctionData('approve',[other,10n]);
    const provided={...services(),knownLaunch:async(asset:string)=>asset===token};
    const decoded=await normalizeFreshReceipt(value,block,provided);
    expect(decoded.reasons).toEqual([]);expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({kind:'fee',tokenAddress:token,quantity:'0',amountUsd:'0',feeUsd:'0.06',feeAttribution:{status:'eligible'}});
    expect((await normalizeFreshReceipt(value,block,provided)).events).toEqual(decoded.events);
    expect((await normalizeFreshReceipt(value,block,{...provided,knownLaunch:async()=>false})).events).toEqual([]);
    value.transaction.input='0x12345678';expect((await normalizeFreshReceipt(value,block,provided)).events).toEqual([]);
  });
  it('retains an unattributed failed gas fact without claiming a token trade or scoped cost', async () => {
    const value = fixture([]); value.receipt.status = '0x0'; const decoded = await normalizeFreshReceipt(value, block, services()); expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({ kind: 'fee', tokenAddress: null, quantity: '0', feeUsd: '0.06', feeAttribution: { status: 'unattributed', nativeFeeWei: '100000000000000' } });
  });
  it.each(['transfer', 'approve', 'transferFrom'])('attributes a failed direct %s only to its verified eligible token contract', async method => {
    const value = fixture([]); value.receipt.status = '0x0'; value.transaction.to = token;
    value.transaction.input = erc20.encodeFunctionData(method, method === 'transferFrom' ? [wallet, other, 10n] : [other, 10n]);
    const decoded = await normalizeFreshReceipt(value, block, services()); expect(decoded.reasons).toEqual([]); expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({ kind: 'fee', tokenAddress: token, feeUsd: '0.06', feeAttribution: { status: 'eligible', tokenAddress: token, contract: token, selector: String(value.transaction.input).slice(0, 10), nativeFeeWei: '100000000000000' } });
    expect(decoded.tokens.map(metadata => metadata.address)).toEqual([token]); expect((await normalizeFreshReceipt(value, block, services())).events).toEqual(decoded.events);
  });
  it('retains the same fee identity when missing token proof is repaired', async () => {
    const value = fixture([]); value.receipt.status = '0x0'; value.transaction.to = token; value.transaction.input = erc20.encodeFunctionData('transfer', [other, 10n]);
    const pending = await normalizeFreshReceipt(value, block, { ...services(), async metadata() { return null; } });
    const resolved = await normalizeFreshReceipt(value, block, services());
    expect(pending.events[0].tokenAddress).toBeNull(); expect(pending.events[0].feeAttribution?.status).toBe('unattributed');
    expect(resolved.events[0].tokenAddress).toBe(token); expect(resolved.events[0].feeAttribution?.status).toBe('eligible');
    expect(resolved.events[0].id).toBe(pending.events[0].id); expect(resolved.events[0].executionKey).toBe(pending.events[0].executionKey);
    expect(resolved.events[0].executionKey).toContain(':native_fee:fee:aggregate'); expect(resolved.events[0].feeKey).toBe(pending.events[0].feeKey);
    const temporaryGap = await normalizeFreshReceipt(value, block, { ...services(), async priceUsd() { return null; } });
    preserveFreshVerifiedValuations(temporaryGap, new Map(pending.events.map(event => [event.id, event])));
    expect(temporaryGap.events[0].feeUsd).toBe('0.06'); expect(temporaryGap.events[0].tokenAddress).toBe(token); expect(temporaryGap.reasons).toEqual([]);
  });
  it('keeps old and explicitly excluded token attempts outside new-token accounting', async () => {
    const value = fixture([]); value.receipt.status = '0x0'; value.transaction.to = token; value.transaction.input = erc20.encodeFunctionData('transfer', [other, 10n]);
    const old = await normalizeFreshReceipt(value, block, { ...services(), async knownLaunch() { return false; } });
    expect(old.events[0].feeAttribution?.status).toBe('excluded'); expect(old.events[0].feeUsd).toBe('0.06');
    value.transaction.to = quote;
    const excluded = await normalizeFreshReceipt(value, block, services()); expect(excluded.events[0].feeAttribution).toMatchObject({ status: 'excluded', tokenAddress: quote, nativeFeeWei: '100000000000000' });
  });
  it('rejects embedded token addresses, malformed calldata and unavailable token proof as attribution', async () => {
    const value = fixture([]); value.receipt.status = '0x0'; value.transaction.input = `0xdeadbeef${word(token)}${word(wallet)}`;
    const malicious = await normalizeFreshReceipt(value, block, { ...services(), async metadata() { throw new Error('must_not_scan_embedded_addresses'); } });
    expect(malicious.events[0].feeAttribution?.status).toBe('unattributed');
    value.transaction.to = token; value.transaction.input = `${erc20.encodeFunctionData('transfer', [other, 10n])}00`;
    expect((await normalizeFreshReceipt(value, block, services())).events[0].feeAttribution?.status).toBe('unattributed');
    value.transaction.input = erc20.encodeFunctionData('transfer', [other, 10n]);
    expect((await normalizeFreshReceipt(value, block, { ...services(), async metadata() { return null; } })).events[0].feeAttribution?.status).toBe('unattributed');
  });
  it('preserves unknown unallocated gas in exact native units without stalling decoding solely for its USD value', async () => {
    const value = fixture([]); value.receipt.status = '0x0';
    const unknown = await normalizeFreshReceipt(value, block, { ...services(), async priceUsd() { return null; } });
    expect(unknown.events[0].feeUsd).toBeNull(); expect(unknown.events[0].feeAttribution).toEqual({ status: 'unattributed', nativeFeeWei: '100000000000000' }); expect(unknown.reasons).toEqual([]);
    value.transaction.to = token; value.transaction.input = erc20.encodeFunctionData('approve', [other, 10n]);
    const eligible = await normalizeFreshReceipt(value, block, { ...services(), async priceUsd() { return null; } });
    expect(eligible.events[0].feeAttribution?.status).toBe('eligible'); expect(eligible.reasons).toContain('wallet_fee_valuation_unavailable');
  });
  it('retains a failed authenticated AA operation fee without inventing calldata attribution or charging bundler gas', async () => {
    const ep = FRESH_ENTRY_POINTS[0], value = fixture([]); value.transaction.from = other; value.transaction.to = ep;
    value.receipt.logs = [log(ep, [beforeExecutionTopic], '0x', 0), log(ep, [userOperationTopic, hash('c'), `0x${word(wallet)}`, `0x${'0'.repeat(64)}`], `0x${word(1n)}${word(0n)}${word(500n)}${word(100n)}`, 1)];
    const decoded = await normalizeFreshReceipt(value, block, services()); expect(decoded.events).toHaveLength(1); expect(decoded.reasons).toEqual([]);
    expect(decoded.events[0]).toMatchObject({ kind: 'fee', tokenAddress: null, feeAttribution: { status: 'unattributed', nativeFeeWei: '500' } });
    expect(decoded.events[0].feeUsd).toBe('0.0000000000003');
  });
  it('trace ignores reverted and delegate-call movements and verifies transaction identity', () => {
    const value = fixture([]); value.transaction.value = '0x64'; const trace = { type: 'CALL', from: wallet, to: other, value: '0x64', calls: [{ type: 'CALL', from: other, to: wallet, value: '0xa' }, { type: 'CALL', from: other, to: wallet, value: '0x64', error: 'revert' }, { type: 'DELEGATECALL', from: wallet, to: other, value: '0x64' }] };
    expect(freshTraceMatchesTransaction(trace, value.transaction)).toBe(true); expect(freshNativeDelta(trace, wallet)).toBe(-90n);
    expect(freshTraceMatchesTransaction({ ...trace, from: other }, value.transaction)).toBe(false);
  });
});
