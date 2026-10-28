import { describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import type { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import { transferTopic } from '../swap.js';
import { decodeFreshEvidence, encodeFreshEvidence, type FreshCapturedReceipt } from './capture.js';
import { createFreshUrgentEvidenceCapture, freshUrgentTokenTargets, mergeFreshUrgentEvidence, persistFreshUrgentEvidence, FRESH_URGENT_EVIDENCE_MAX_RPC } from './urgentEvidence.js';
import type { FreshStateReadEvidence } from './stateEvidence.js';
import{GANG_TOKEN_ADDRESS,type FreshExistingTokenPermission}from'./tracking.js';
import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';
import{WBNB,PCS_V2_FACTORY,FLAP_PORTAL,FOUR_HELPER,flapInterface}from'../launchpad.js';
import{poolMarketAbi,oracleMarketAbi,TRUSTED_QUOTE_FEEDS}from'../nodeMarketProtocols.js';
import{factoryCode,pairCode}from'./currentQuote.fixture.js';
import{freshPoolNativePair}from'./currentPoolQuote.js';
import{createFreshReceiptRecovery}from'./recovery.js';

const address = (digit: string) => `0x${digit.repeat(40)}`, hash = (digit: string) => `0x${digit.repeat(64)}`;
const wallet = address('1'), other = address('2'), token = address('7'), intermediary = address('8'), blockHash = hash('a'), txHash = hash('b');
const abi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)']);
const word = (value: string) => `0x${value.slice(2).padStart(64, '0')}`;
function fixture(transactionHash = txHash, time = new Date()): FreshCapturedReceipt {
  const log = (asset: string, from: string, to: string, index: number) => ({ address: asset, topics: [transferTopic, word(from), word(to)], data: word('0x1'), logIndex: `0x${index.toString(16)}`,
    transactionHash, transactionIndex: '0x0', blockNumber: '0x65', blockHash });
  return { transaction: { hash: transactionHash, from: wallet, to: other, value: '0x0', blockHash, blockNumber: '0x65', transactionIndex: '0x0', gasPrice: '0x0' },
    receipt: { transactionHash, transactionIndex: '0x0', blockHash, blockNumber: '0x65', status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x0',
      logs: [log(intermediary, other, address('3'), 0), log(token, other, wallet, 1)] }, wallets: [wallet], observedAt: time.toISOString() };
}
const proof = (calls: FreshStateReadEvidence['calls'] = [{ to: token, data: abi.encodeFunctionData('decimals'), result: abi.encodeFunctionResult('decimals', [18]) }]): FreshStateReadEvidence => ({ version: 1, blockNumber: 101, blockHash, calls });

function memory(entries: FreshCapturedReceipt[], time = new Date()) {
  const rows = entries.map(entry => ({ tx_hash: entry.transaction.hash, block_hash: blockHash, block_number: '101', occurred_at: time,
    payload: encodeFreshEvidence(entry), wallet_addresses: [...entry.wallets], decoder_status: 'pending', last_error: 'original_failure' }));
  const calls: { sql: string; params: unknown[] }[] = [];
  let canonical = blockHash;
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<any> => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT e.payload')) return { rows: rows.map(row => ({ ...row, payload: Buffer.from(row.payload) })) };
    if (sql.startsWith('SELECT block_hash')) return { rows: [{ block_hash: canonical }] };
    if (sql.startsWith('SELECT payload')) return { rows: rows.filter(row => row.tx_hash === params[0]).map(row => ({ ...row })) };
    if (sql.startsWith('UPDATE fresh.recent_evidence')) { const row = rows.find(row => row.tx_hash === params[0])!; row.payload = params[2] as Buffer; return { rowCount: 1, rows: [] }; }
    return { rows: [], rowCount: 0 };
  });
  return { rows, calls, query, orphan() { canonical = hash('c'); },
    database: { query, connect: async () => ({ query, release() {} }) } as unknown as Pool };
}

describe('fresh urgent evidence preservation', () => {
  it('persists authentic original quote/native state before pruning and normalizes a captured Flap mark with every historical RPC unavailable',async()=>{
    const now=new Date(),entry=fixture(txHash,now),db=memory([entry],now),base=db.query.getMockImplementation()!,pair=freshPoolNativePair(intermediary),assets=[intermediary,WBNB].sort();
    let currentAnchors=0;db.query.mockImplementation(async(sql:string,p:unknown[]=[])=>{
      if(sql.startsWith('SELECT block_hash'))return{rows:[{block_hash:blockHash,occurred_at:now}]};
      if(sql.startsWith('SELECT block_number::text,block_hash,value'))return{rows:[{block_number:90,block_hash:hash('9'),value:{}}]};
      if(sql.startsWith('SELECT * FROM fresh.launch_facts'))return{rows:p[0]===token?[{status:'eligible',protocol:'flap',block_number:91}]:[]};
      if(sql.includes("c.key='capture'")){currentAnchors++;throw Error('current_anchor_unavailable');}return base(sql,p);
    });
    const curve=[1,5n*10n**11n,5n*10n**26n,10n**15n,6,10n**23n,10n**26n,36n*10n**31n,8n*10n**26n,intermediary,false,hash('9'),0,0,address('0'),0,0,0];
    const stamp=Math.floor(now.getTime()/1000),feed=TRUSTED_QUOTE_FEEDS[WBNB];
    const rpc=vi.fn(async(method:string,p:any[])=>{
      if(method==='eth_chainId'){expect(p).toEqual([]);return'0x38';}
      expect(p[1]).toEqual({blockHash,requireCanonical:true});
      if(method==='eth_getCode'){expect([PCS_V2_FACTORY,pair]).toContain(p[0]);return p[0]===PCS_V2_FACTORY?factoryCode:pairCode;}
      expect(method).toBe('eth_call');const call=p[0];
      if(call.to===FOUR_HELPER)throw Error('not_fourmeme');
      if(call.to===FLAP_PORTAL&&call.data===flapInterface.encodeFunctionData('getTokenV8Safe',[token]))return flapInterface.encodeFunctionResult('getTokenV8Safe',[curve]);
      if(call.to===feed.feed){const parsed=oracleMarketAbi.parseTransaction(call)!;const result:Record<string,unknown[]>={decimals:[8],description:[feed.description],latestRoundData:[1,600n*10n**8n,stamp-1,stamp-1,1]};return oracleMarketAbi.encodeFunctionResult(parsed.name,result[parsed.name]);}
      if(call.to===PCS_V2_FACTORY){const args=poolMarketAbi.decodeFunctionData('getPair',call.data);return poolMarketAbi.encodeFunctionResult('getPair',[[String(args[0]).toLowerCase(),String(args[1]).toLowerCase()].sort().join(',')===assets.join(',')?pair:address('0')]);}
      if(call.to===pair){const parsed=poolMarketAbi.parseTransaction(call)!;const values:Record<string,unknown[]>={factory:[PCS_V2_FACTORY],token0:[assets[0]],token1:[assets[1]],getReserves:[10n**6n,2n*10n**18n,1]};return poolMarketAbi.encodeFunctionResult(parsed.name,values[parsed.name]);}
      if(call.data===abi.encodeFunctionData('decimals'))return abi.encodeFunctionResult('decimals',[18]);
      if(call.data===abi.encodeFunctionData('totalSupply'))return abi.encodeFunctionResult('totalSupply',[10n**27n]);
      throw Error('optional_state_unavailable');
    })as unknown as Rpc;
    const captured=await createFreshUrgentEvidenceCapture(db.database,rpc)({now}),kept=decodeFreshEvidence(db.rows[0].payload);
    expect(kept.recoveryEvidence?.retainedNativeQuotes).toHaveLength(1);expect(kept.recoveryEvidence!.retainedNativeQuotes![0]).toMatchObject({quoteAddress:intermediary,code:{block:{number:101,hash:blockHash}},observation:'block_end'});
    expect(captured.rpcCalls).toBeLessThanOrEqual(FRESH_URGENT_EVIDENCE_MAX_RPC);expect(db.rows[0].decoder_status).toBe('pending');
    const none=vi.fn(async()=>{throw Error('historical_state_code_and_logs_pruned');})as unknown as Rpc;
    const target={number:101,hash:blockHash,timestamp:now.toISOString()},recovery=createFreshReceiptRecovery(db.database,none,kept,target);
    expect(await recovery.priceUsd(token)).toBe('1.2');expect(none).not.toHaveBeenCalled();expect(currentAnchors).toBe(0);
    expect(recovery.snapshot()!.flapCurveQuotes![0].conversion?.kind).toBe('retained_target_pool_native_v2');
    expect(recovery.snapshot()!.retainedNativeQuotes).toEqual(kept.recoveryEvidence!.retainedNativeQuotes);
    expect(kept.receipt).toEqual(entry.receipt);expect(kept.transaction).toEqual(entry.transaction);
    expect(db.calls.some(c=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(c.sql))).toBe(false);
  });
  it.each(['valid','wrong_registry','unadmitted'] as const)('captures bounded full historical native-curve proof only after exact registry binding: %s',async mode=>{
    const sample=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/ant-native-curve-marks.json.gz',import.meta.url))).toString()).rows[0],curve=sample.proof,at=curve.target,now=new Date(Date.parse(at.timestamp)+1000),entry=fixture(txHash,now);
    entry.receipt.logs=[entry.receipt.logs[1]];entry.receipt.logs[0].address=curve.tokenAddress;
    for(const v of[entry.transaction,entry.receipt,...entry.receipt.logs])Object.assign(v,{blockNumber:'0x'+at.number.toString(16),blockHash:at.hash});
    const db=memory([entry],new Date(at.timestamp));Object.assign(db.rows[0],{block_number:String(at.number),block_hash:at.hash});const base=db.query.getMockImplementation()!;
    db.query.mockImplementation(async(sql:string,p:unknown[]=[])=>{if(sql.startsWith('SELECT block_hash'))return{rows:[{block_hash:at.hash,occurred_at:at.timestamp}]};if(sql.startsWith('SELECT block_number::text,block_hash,value'))return{rows:[{block_number:at.number-100,block_hash:hash('9'),value:{}}]};if(sql.startsWith('SELECT * FROM fresh.launch_facts'))return{rows:mode==='unadmitted'?[]:[{status:'eligible',protocol:'evm_creation',block_number:at.number-10}]};return base(sql,p);});
    let registrySeen=false;const rpc=vi.fn(async(method:string,p:unknown[])=>{expect(p[1]).toEqual({blockHash:at.hash,requireCanonical:true});if(method==='eth_getCode'){expect(registrySeen).toBe(true);expect(p[0]).toBe(curve.poolAddress);return curve.runtime.code;}expect(method).toBe('eth_call');const call=p[0]as{to:string;data:string};if(call.to===curve.tokenAddress&&call.data===abi.encodeFunctionData('decimals'))return abi.encodeFunctionResult('decimals',[18]);if(call.to===curve.tokenAddress&&call.data===abi.encodeFunctionData('totalSupply'))return abi.encodeFunctionResult('totalSupply',[100]);const retained=curve.state.calls.find((v:any)=>v.to===call.to&&v.data===call.data);if(retained){if(call.data.startsWith('0x3cf28b5a')){registrySeen=true;return mode==='wrong_registry'?'0x'+'0'.repeat(192):retained.result;}return retained.result;}throw Error('optional_state_unavailable');})as unknown as Rpc;
    const result=await createFreshUrgentEvidenceCapture(db.database,rpc)({now});const kept=decodeFreshEvidence(db.rows[0].payload);
    expect(kept.recoveryEvidence?.threeXdCurvePrices?.length??0).toBe(mode==='valid'?1:0);expect((rpc as any).mock.calls.filter(([m]:any[])=>m==='eth_getCode').length).toBe(mode==='valid'?1:0);
    if(mode==='valid'){const keptCurve=kept.recoveryEvidence!.threeXdCurvePrices![0];expect({...keptCurve,state:undefined}).toEqual({...curve,state:undefined});expect(keptCurve.state.calls).toEqual(expect.arrayContaining(curve.state.calls));expect(keptCurve.state.calls).toHaveLength(curve.state.calls.length);}expect(result.rpcCalls).toBeLessThanOrEqual(FRESH_URGENT_EVIDENCE_MAX_RPC);expect(kept.receipt).toEqual(entry.receipt);expect(kept.transaction).toEqual(entry.transaction);expect(db.rows[0].decoder_status).toBe('pending');expect(db.rows[0].last_error).toBe('original_failure');expect(db.calls.some(c=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(c.sql))).toBe(false);
  });
  it('includes the admitted existing GANG token in optional quote evidence without inventing a launch fact',async()=>{
    const now=new Date(),entry=fixture(txHash,now);entry.receipt.logs[1].address=GANG_TOKEN_ADDRESS;const m=memory([entry],now),original=m.query.getMockImplementation()!;
    const start={block_number:'90',block_hash:hash('9'),value:{startBlock:90,startHash:hash('9'),startTime:'2026-10-25T00:00:00.000Z'}};
    let permission:FreshExistingTokenPermission|null={version:1,kind:'explicit_existing',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,startBlock:90,startHash:hash('9'),startTime:start.value.startTime,fromBlock:91,approvedAt:now.toISOString(),reason:'user_approved_gang_only'};
    m.query.mockImplementation(async(sql:string,params:unknown[]=[])=>{
      if(sql.startsWith('SELECT block_number::text,block_hash,value'))return{rows:[start]};
      if(sql.startsWith('SELECT value FROM fresh.checkpoints WHERE key=$1'))return{rows:permission?[{value:permission}]:[]};
      return original(sql,params);
    });
    const nameSelector='0x06fdde03',rpc=vi.fn(async(_method:string,params:unknown[])=>{
      const call=params[0]as{data:string};if(call.data===abi.encodeFunctionData('decimals'))return abi.encodeFunctionResult('decimals',[18]);
      if(call.data===abi.encodeFunctionData('totalSupply'))return abi.encodeFunctionResult('totalSupply',[10n**24n]);return'0x';
    })as unknown as Rpc;
    await createFreshUrgentEvidenceCapture(m.database,rpc)({now});
    expect((rpc as any).mock.calls.some(([,params]:any[])=>params[0].to===GANG_TOKEN_ADDRESS&&params[0].data===nameSelector)).toBe(true);
    expect(m.calls.some(call=>/INSERT INTO fresh.launch_facts|financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(call.sql))).toBe(false);
    const n=memory([entry],now),fallback=n.query.getMockImplementation()!;permission=null;
    n.query.mockImplementation(async(sql:string,params:unknown[]=[])=>sql.startsWith('SELECT block_number::text,block_hash,value')?{rows:[start]}:fallback(sql,params));
    (rpc as any).mockClear();await createFreshUrgentEvidenceCapture(n.database,rpc)({now});
    expect((rpc as any).mock.calls.some(([,params]:any[])=>params[0].to===GANG_TOKEN_ADDRESS&&params[0].data===nameSelector)).toBe(false);
  });
  it('prioritizes wallet assets then intermediates, bounds token count and ignores malformed/spoof transfer shapes', () => {
    const entry = fixture(); expect(freshUrgentTokenTargets(entry)).toEqual([token, intermediary]);
    entry.receipt.logs[0].removed = true; expect(freshUrgentTokenTargets(entry)).toEqual([token]);
    entry.receipt.logs[0].removed = false; entry.receipt.logs[0].topics.push(hash('c')); expect(freshUrgentTokenTargets(entry)).toEqual([token]);
    expect(freshUrgentTokenTargets(fixture(), 1)).toEqual([token]);
  });
  it('captures fee-attribution precision for exact approvals and failed transfers without treating a router as a token', () => {
    const entry = fixture(), call = new Interface(['function approve(address,uint256)', 'function transfer(address,uint256)']); entry.receipt.logs = []; entry.transaction.to = token;
    entry.transaction.input = call.encodeFunctionData('approve', [other, 10]); expect(freshUrgentTokenTargets(entry)).toEqual([token]);
    entry.receipt.status = '0x0'; entry.transaction.input = call.encodeFunctionData('transfer', [other, 10]); expect(freshUrgentTokenTargets(entry)).toEqual([token]);
    entry.transaction.input += '00'; expect(freshUrgentTokenTargets(entry)).toEqual([]);
    entry.transaction.input = '0x12345678'; expect(freshUrgentTokenTargets(entry)).toEqual([]);
  });
  it('merges independent successes while preserving concurrent recovery, trace and original first diagnostics', () => {
    const selected = fixture(), latest = structuredClone(selected);
    latest.stateEvidence = proof([{ to: token, data: abi.encodeFunctionData('totalSupply'), result: abi.encodeFunctionResult('totalSupply', [100]) }]);
    const firstFailure = { version: 1 as const, at: latest.observedAt, reasons: ['trade_value_unavailable'] };
    latest.decodeDiagnostics = { version: 1, valuationReasons: ['trade_value_unavailable'], firstFailure };
    (latest as any).recoveryEvidence = { version: 1, original: 'recovery_proof' }; (latest as any).trace = { original: 'trace_proof' };
    const merged = decodeFreshEvidence(mergeFreshUrgentEvidence(selected, latest, proof())!);
    expect(merged.stateEvidence!.calls).toHaveLength(2); expect(merged.recoveryEvidence).toEqual(latest.recoveryEvidence);
    expect(merged.decodeDiagnostics).toEqual(latest.decodeDiagnostics); expect(merged.trace).toEqual(latest.trace);
    expect(merged.receipt).toEqual(latest.receipt); expect(merged.transaction).toEqual(latest.transaction);
    expect(mergeFreshUrgentEvidence(merged, merged, proof())).toBeNull();
  });
  it('rejects conflicting, wrong block/current and inconsistent wallet proof without replacing existing bytes', () => {
    const selected = fixture(), latest = structuredClone(selected); latest.stateEvidence = proof(); const original = encodeFreshEvidence(latest);
    expect(() => mergeFreshUrgentEvidence(selected, latest, proof([{ ...proof().calls[0], result: abi.encodeFunctionResult('decimals', [6]) }]))).toThrow('urgent_state_evidence_conflict');
    expect(() => mergeFreshUrgentEvidence(selected, latest, { ...proof(), blockHash: hash('c') })).toThrow('urgent_state_evidence_invalid');
    expect(() => mergeFreshUrgentEvidence(selected, latest, { ...proof(), blockNumber: 102 })).toThrow('urgent_state_evidence_invalid');
    expect(() => mergeFreshUrgentEvidence(selected, { ...latest, wallets: [other] }, proof())).toThrow('urgent_receipt_context_changed');
    expect(encodeFreshEvidence(latest)).toEqual(original);
  });
  it('rechecks canonical header and latest registration wallet context before saving and has no financial writer', async () => {
    const entry = fixture(), db = memory([entry]); db.orphan();
    expect(await persistFreshUrgentEvidence(db.database, entry, proof())).toBe(false);
    expect(db.calls.some(call => call.sql.startsWith('UPDATE'))).toBe(false);
    const current = memory([entry]); current.rows[0].wallet_addresses = [other];
    await expect(persistFreshUrgentEvidence(current.database, entry, proof())).rejects.toThrow('urgent_wallet_context_changed');
    expect(current.calls.at(-1)!.sql).toBe('ROLLBACK');
    expect(current.calls.some(call => /financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(call.sql))).toBe(false);
  });
  it('durably saves a successful decimals sibling before a stalled supply call ends; failed reads never become proof', async () => {
    const now = new Date(), entry = fixture(txHash, now), db = memory([entry], now); let release!: () => void, blocked = false;
    const supplied = new Promise<void>(resolve => { release = resolve; });
    const rpc: Rpc = async <T>(_method: string, params: unknown[]) => {
      expect(params[1]).toEqual({ blockHash, requireCanonical: true });
      const call = params[0] as { to: string; data: string };
      if (call.to === token && call.data === abi.encodeFunctionData('decimals')) return abi.encodeFunctionResult('decimals', [18]) as T;
      if (call.to === token && call.data === abi.encodeFunctionData('totalSupply')) { blocked = true; await supplied; }
      throw Error('historical_state_unavailable');
    };
    const run = createFreshUrgentEvidenceCapture(db.database, rpc)({ now });
    await vi.waitFor(() => { expect(blocked).toBe(true); expect(decodeFreshEvidence(db.rows[0].payload).stateEvidence?.calls).toEqual(proof().calls); });
    expect(db.rows[0].decoder_status).toBe('pending'); expect(db.rows[0].last_error).toBe('original_failure'); release();
    const result = await run; expect(result.saved).toBe(1); expect(result.unavailable).toBe(1);
    expect(db.calls.every(call => !/financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(call.sql))).toBe(true);
  });
  it('bounds concurrent RPC, retains only exact canonical state and selects newest serviceable evidence independent of old repairs', async () => {
    const now = new Date(), db = memory([fixture(hash('b'), now), fixture(hash('c'), now), fixture(hash('d'), now), fixture(hash('e'), now)], now);
    let active = 0, max = 0;
    const rpc: Rpc = async <T>(method: string, params: unknown[]) => {
      expect(method).toBe('eth_call'); expect(params[1]).toEqual({ blockHash, requireCanonical: true });
      active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return `0x${'0'.repeat(63)}1` as T;
    };
    const result = await createFreshUrgentEvidenceCapture(db.database, rpc)({ now });
    expect(max).toBeLessThanOrEqual(2); expect(result.rpcCalls).toBeLessThanOrEqual(FRESH_URGENT_EVIDENCE_MAX_RPC); expect(result.receipts).toBe(4);
    const selection = db.calls[0]; expect(selection.sql).toMatch(/b.occurred_at>=\$1/); expect(selection.sql).toMatch(/ORDER BY e.block_number DESC/); expect(selection.params[2]).toBe(32);
    expect(decodeFreshEvidence(db.rows[0].payload).stateEvidence!.calls.length).toBeGreaterThan(0);
  });
  it('does not start old/current substitutions or keep retrying a fixed failed top candidate ahead of fresh lower rows', async () => {
    const now = new Date(), entries = [fixture(hash('b'), now), fixture(hash('c'), now)], db = memory(entries, now);
    const rpc = vi.fn(async () => { throw Error('state_unavailable'); }) as unknown as Rpc, capture = createFreshUrgentEvidenceCapture(db.database, rpc);
    expect((await capture({ now, limit: 1 })).receipts).toBe(1);
    expect((await capture({ now, limit: 1 })).receipts).toBe(1);
    expect((await capture({ now, limit: 1 })).receipts).toBe(0);
    const old = memory([fixture(txHash, now)], new Date(now.getTime() - 60_000)), oldRpc = vi.fn(async () => '0x') as unknown as Rpc;
    const result = await createFreshUrgentEvidenceCapture(old.database, oldRpc)({ now }); expect(result.rpcCalls).toBe(0); expect(oldRpc).not.toHaveBeenCalled();
  });
  it('rechecks the pass deadline after waiting for a wire slot without abandoning either in-flight request', async () => {
    const now = new Date(), db = memory([fixture(hash('b'), now), fixture(hash('c'), now)], now); let elapsed = 0, release!: () => void;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed), wait = new Promise<void>(resolve => { release = resolve; });
    const rpc = vi.fn(async () => { await wait; return abi.encodeFunctionResult('decimals', [18]); }) as unknown as Rpc;
    try {
      const work = createFreshUrgentEvidenceCapture(db.database, rpc)({ now });
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2)); elapsed = 9_000; release();
      const result = await work; expect(rpc).toHaveBeenCalledTimes(2); expect(result.rpcCalls).toBeGreaterThanOrEqual(2);
      expect(decodeFreshEvidence(db.rows[0].payload).stateEvidence!.calls.length).toBe(2);
    } finally { release(); clock.mockRestore(); }
  });
  it('enforces a hard per-pass wire budget even with eight receipts and distinct intermediate assets', async () => {
    const now = new Date(), entries = Array.from({ length: 8 }, (_, index) => {
      const entry = fixture(`0x${(index + 1).toString(16).padStart(64, '0')}`, now), first = entry.receipt.logs[1];
      entry.receipt.logs = Array.from({ length: 8 }, (__, asset) => ({ ...first, address: `0x${(index * 8 + asset + 100).toString(16).padStart(40, '0')}`, logIndex: `0x${asset.toString(16)}` })); return entry;
    });
    const db = memory(entries, now), rpc = vi.fn(async () => word('0x1')) as unknown as Rpc;
    const result = await createFreshUrgentEvidenceCapture(db.database, rpc)({ now, limit: 8 });
    expect(result.rpcCalls).toBe(FRESH_URGENT_EVIDENCE_MAX_RPC); expect(rpc).toHaveBeenCalledTimes(FRESH_URGENT_EVIDENCE_MAX_RPC);
  });
});
