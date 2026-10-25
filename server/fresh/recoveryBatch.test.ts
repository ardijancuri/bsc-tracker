import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Rpc } from '../rpc.js';
import { encodeFreshEvidence, type FreshCapturedReceipt } from './capture.js';
import { createFreshRecoveryBatch,freshRecoveryCaptureHealthy,type FreshRecoveryCaptureHealth } from './recoveryBatch.js';

const token = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const block = (n: number) => ({ number: n, hash: hash(n), timestamp: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString() });
const hex = (n: number) => `0x${n.toString(16)}`;
const rpc: Rpc = async () => { throw Error('network_forbidden'); };
function source(n: number, selected: string | null = token) {
  const b = block(n), tx = hash(100_000 + n), entry: FreshCapturedReceipt = {
    transaction: { hash: tx, from: other, to: token, value: '0x0', blockHash: b.hash, blockNumber: hex(n), transactionIndex: '0x0' },
    receipt: { transactionHash: tx, blockHash: b.hash, blockNumber: hex(n), transactionIndex: '0x0', status: '0x1', gasUsed: '0x1', logs: [] },
    wallets: [other], observedAt: b.timestamp,
    ...(selected ? { stateEvidence: { version: 1 as const, blockNumber: n, blockHash: b.hash,
      calls: [{ to: selected, data: '0x313ce567', result: `0x${'9'.padStart(64, '0')}` }] } } : {}),
  };
  const payload = encodeFreshEvidence(entry);
  return { tx_hash: tx, block_hash: b.hash, block_number: n, transaction_index: 0, occurred_at: b.timestamp,
    payload, payload_bytes: payload.length, expires_at: Date.now() + 72 * 3600_000, entry };
}
function fixture(rows = [source(10)], selectedTargets = [block(1000), block(1001)]) {
  let clock = Date.now(), revision = 1,head=Math.max(...selectedTargets.map(b=>b.number));
  const headers = new Map([...rows.map(row => [row.block_number, row.block_hash] as const), ...selectedTargets.map(b => [b.number, b.hash] as const)]);
  const calls = { scans: 0, reloads: 0, epochs: 0 };
  const database = { async query(sql: string, values: any[]) {
    if (sql.includes("SELECT revision,value->>'startBlock'")) { calls.epochs++; return { rows: [{ revision, start_block: 0,block_number:head }] }; }
    if(sql.includes('b.occurred_at>=$2'))return {rows:rows.filter(row=>row.expires_at>Number(values[0])&&Date.parse(row.occurred_at)>=Number(values[1])&&row.block_number<=values[2]&&headers.get(row.block_number)===row.block_hash)
      .sort((a,b)=>b.block_number-a.block_number).slice(0,2)};
    if (sql.includes('WITH candidates AS')) {
      calls.scans++;
      const cursor = Number(values[1]), count = Number(values[5]), maxPayload = values[6], byteBudget = values[7];
      let bytes = 0;
      return { rows: rows.filter(row => row.block_number > cursor && row.block_number<=values[8]&&headers.get(row.block_number) === row.block_hash && row.expires_at > Number(values[0]))
        .sort((a, b) => a.block_number - b.block_number).slice(0, count).map(row => {
          if (row.payload_bytes <= maxPayload) bytes += row.payload_bytes;
          return { ...row, payload: bytes <= byteBudget && row.payload_bytes <= maxPayload ? row.payload : null };
        }) };
    }
    if (sql.includes('JOIN fresh.recent_blocks target')) {
      calls.reloads++;
      if (headers.get(values[2]) !== values[3] || block(values[2]).timestamp !== values[4]) return { rows: [] };
      return { rows: rows.filter(row => values[0].includes(row.tx_hash) && values[1].includes(row.block_hash)
        && headers.get(row.block_number) === row.block_hash && row.block_number < values[2]
        && row.expires_at > Number(values[5]) && row.payload.length <= values[6]).sort((a, b) => b.block_number - a.block_number) };
    }
    throw Error(`unexpected_sql:${sql}`);
  } } as unknown as Pick<Pool, 'query'>;
  return { database, rows, headers, calls, now: () => clock, advance: (ms: number) => { clock += ms; },setClock:(value:number)=>{clock=value;},setHead:(value:number)=>{head=value;}, reorg: () => { revision++; } };
}

describe('bounded reusable canonical receipt metadata index', () => {
  it('warms an incomplete cycle every five seconds only with fresh measured healthy capture, without expiring memo inputs',async()=>{
    const f=fixture([source(1),source(2),source(3)]),health=():FreshRecoveryCaptureHealth=>({checkedAt:f.now(),nodeHead:1007,confirmedHeadBlock:1001,capturedBlock:1001,lagBlocks:0});
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxRows:1,captureHealth:health});let loads=0;
    await batch.memo('immutable',async()=>++loads);await batch.sources(token,block(1000));
    expect(batch.stats()).toMatchObject({cursorBlock:1,sliceIntervalMs:5000,cycle:1});
    f.advance(4999);await batch.sources(token,block(1000));expect(batch.stats().cursorBlock).toBe(1);
    f.advance(1);await Promise.all([batch.sources(token,block(1000)),batch.sources(other,block(1001))]);
    expect(batch.stats()).toMatchObject({cursorBlock:2,cycleScannedRows:2,scans:2,cycle:1});
    expect(await batch.memo('immutable',async()=>++loads)).toBe(1);expect(loads).toBe(1);
    f.setHead(2000);f.advance(5000);await batch.sources(token,block(1000));
    expect(batch.stats()).toMatchObject({cursorBlock:3,cycleCeilingBlock:1001,cycle:1});
  });
  it('keeps default and completed cycles on the minute interval and resumes a healthy incomplete cursor without resetting it',async()=>{
    const f=fixture([source(1)]);let health:FreshRecoveryCaptureHealth|undefined;
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxRows:1,captureHealth:()=>health});
    await batch.sources(token,block(1000));f.advance(5000);await batch.sources(token,block(1000));
    expect(batch.stats()).toMatchObject({scans:1,sliceIntervalMs:60000,cycle:1});
    health={checkedAt:f.now(),nodeHead:1007,confirmedHeadBlock:1001,capturedBlock:1001,lagBlocks:0};
    await batch.sources(token,block(1000));expect(batch.stats()).toMatchObject({scans:2,cycleComplete:true,cursorBlock:1});
    f.advance(5000);health.checkedAt=f.now();await batch.sources(token,block(1000));
    expect(batch.stats()).toMatchObject({scans:2,sliceIntervalMs:60000,cycleComplete:true});
    f.advance(55000);health.checkedAt=f.now();await batch.sources(token,block(1000));expect(batch.stats().cycle).toBe(2);
  });
  it.each([
    ['missing',undefined],['stale',{checkedAt:4999}],['future',{checkedAt:10001}],['lag',{capturedBlock:968,lagBlocks:33}],
    ['wrong_lag',{lagBlocks:1}],['wrong_confirmations',{nodeHead:1008}],['ahead',{capturedBlock:1002}],
    ['regressed_head',{nodeHead:1000,confirmedHeadBlock:994}],
    ['negative',{nodeHead:-1}],['fractional',{lagBlocks:0.5}],['NaN',{checkedAt:NaN}],
  ])('does not accelerate when capture health is %s',(_name,patch)=>{
    const valid={checkedAt:10000,nodeHead:1007,confirmedHeadBlock:1001,capturedBlock:1001,lagBlocks:0};
    expect(freshRecoveryCaptureHealthy(patch?{...valid,...patch}:undefined,1001,10000)).toBe(false);
  });
  it('accepts the exact fresh 32-block boundary but yields when capture stops succeeding',async()=>{
    expect(freshRecoveryCaptureHealthy({checkedAt:5000,nodeHead:1039,confirmedHeadBlock:1033,capturedBlock:1001,lagBlocks:32},1001,10000)).toBe(true);
    const f=fixture([source(1),source(2)]);let healthy=true;
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxRows:1,captureHealth:()=>healthy?{checkedAt:f.now(),nodeHead:1007,confirmedHeadBlock:1001,capturedBlock:1001,lagBlocks:0}:undefined});
    await batch.sources(token,block(1000));healthy=false;f.advance(5000);await batch.sources(token,block(1000));
    expect(batch.stats()).toMatchObject({scans:1,cursorBlock:1,sliceIntervalMs:60000});
    healthy=true;await batch.sources(token,block(1000));expect(batch.stats()).toMatchObject({scans:2,cursorBlock:2,sliceIntervalMs:5000});
  });
  it('reloads an exact retained locator without scanning a cold index or calling the node',async()=>{
    const f=fixture(),batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxRows:1}),row=f.rows[0];
    const hint={transactionHash:row.tx_hash,blockNumber:row.block_number,blockHash:row.block_hash,payloadSha256:createHash('sha256').update(row.payload).digest('hex')};
    expect((await batch.sources(token,block(1000),hint)).map(s=>s.block.number)).toEqual([10]);
    expect(f.calls.scans).toBe(0);expect(f.calls.reloads).toBe(1);expect(batch.stats().scans).toBe(0);
    expect(await batch.sources(other,block(1000),hint)).toEqual([]);
  });
  it('treats malformed, oversized, unknown and nonmatching hints only as failed lookups before bounded discovery',async()=>{
    for(const patch of[{transactionHash:hash(999)},{blockHash:hash(999)},{blockNumber:11},{blockNumber:1000},{payloadSha256:'wrong'},{extra:true},{extra:'x'.repeat(2048)}]){
      const f=fixture(),batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now}),row=f.rows[0],hint={transactionHash:row.tx_hash,blockNumber:row.block_number,blockHash:row.block_hash,payloadSha256:createHash('sha256').update(row.payload).digest('hex'),...patch};
      expect(await batch.sources(token,block(1000),hint)).toHaveLength(1);expect(f.calls.scans).toBeGreaterThan(0);
    }
  });
  it('preserves canonicality, expiration and checksum guards on direct locators',async()=>{
    for(const mutation of[(f:ReturnType<typeof fixture>)=>{f.rows[0].expires_at=f.now()-1;},(f:ReturnType<typeof fixture>)=>{f.headers.set(10,hash(999));},(f:ReturnType<typeof fixture>)=>{f.headers.set(1000,hash(999));},(f:ReturnType<typeof fixture>)=>{f.rows[0].payload[4]^=1;}]){
      const f=fixture(),row=f.rows[0],hint={transactionHash:row.tx_hash,blockNumber:row.block_number,blockHash:row.block_hash,payloadSha256:createHash('sha256').update(row.payload).digest('hex')};mutation(f);
      expect(await createFreshRecoveryBatch(f.database,rpc,{now:f.now}).sources(token,block(1000),hint)).toEqual([]);
    }
  });
  it('drops the fast path after an additive envelope update and reloads its actual raw proof through normal discovery',async()=>{
    const f=fixture(),row=f.rows[0],hint={transactionHash:row.tx_hash,blockNumber:row.block_number,blockHash:row.block_hash,payloadSha256:createHash('sha256').update(row.payload).digest('hex')};
    row.entry.trace={type:'CALL',from:other,to:token,value:'0x0'};row.payload=encodeFreshEvidence(row.entry);row.payload_bytes=row.payload.length;
    const result=await createFreshRecoveryBatch(f.database,rpc,{now:f.now}).sources(token,block(1000),hint);
    expect(result).toHaveLength(1);expect(result[0].entry.trace).toEqual(row.entry.trace);expect(f.calls.scans).toBeGreaterThan(0);
  });
  it('rejects a direct reload overtaken by a capture-revision change',async()=>{
    const f=fixture(),base=f.database;let changed=false,batch:ReturnType<typeof createFreshRecoveryBatch>;
    const database={query:async(sql:string,values:any[])=>{const result=await base.query(sql,values);if(sql.includes('JOIN fresh.recent_blocks target')&&!changed){changed=true;f.reorg();await batch.memo('reorg-observed',async()=>null);}return result;}}as unknown as Pick<Pool,'query'>;
    batch=createFreshRecoveryBatch(database,rpc,{now:f.now});const row=f.rows[0],hint={transactionHash:row.tx_hash,blockNumber:row.block_number,blockHash:row.block_hash,payloadSha256:createHash('sha256').update(row.payload).digest('hex')};
    expect(await batch.sources(token,block(1000),hint)).toEqual([]);expect(f.calls.scans).toBe(0);
  });
  it('finds an earlier matching raw call beyond 256 unrelated receipts and shares the scan across targets', async () => {
    const f = fixture([source(1), ...Array.from({ length: 400 }, (_, i) => source(i + 2, null))]);
    const batch = createFreshRecoveryBatch(f.database, rpc, { now: f.now, pageSize: 100 });
    expect((await batch.sources(token, block(1000))).map(s => s.block.number)).toEqual([1]);
    const scanned = f.calls.scans;
    expect(scanned).toBe(6);
    expect((await batch.sources(token, block(1001))).map(s => s.block.number)).toEqual([1]);
    expect(f.calls.scans).toBe(scanned); expect(f.calls.reloads).toBe(2);
    expect(batch.stats()).toMatchObject({ scannedRows: 401, indexedReferences: 1, truncated: false, scans: 1 });
  });

  it('reloads source payload identity and canonical target/source headers rather than trusting cached locators', async () => {
    const f = fixture(), batch = createFreshRecoveryBatch(f.database, rpc, { now: f.now });
    expect(await batch.sources(token, block(1000))).toHaveLength(1);
    f.rows[0].payload = Buffer.from(f.rows[0].payload); f.rows[0].payload[4] ^= 1;
    expect(await batch.sources(token, block(1000))).toEqual([]);
    f.rows[0].payload = encodeFreshEvidence(f.rows[0].entry);
    f.headers.set(10, hash(999)); expect(await batch.sources(token, block(1000))).toEqual([]);
    f.headers.set(10, hash(10)); f.headers.set(1000, hash(999));
    expect(await batch.sources(token, block(1000))).toEqual([]);
  });

  it('rejects foreign block calls, modified receipt identity, future observations and expired originals', async () => {
    const foreign = source(10), altered = source(11), future = source(1001);
    foreign.entry.stateEvidence!.blockHash = hash(999); foreign.payload = encodeFreshEvidence(foreign.entry);
    altered.entry.receipt.transactionHash = hash(999); altered.payload = encodeFreshEvidence(altered.entry);
    const f = fixture([foreign, altered, future]), batch = createFreshRecoveryBatch(f.database, rpc, { now: f.now });
    expect(await batch.sources(token, block(1000))).toEqual([]);
    const valid = source(12); f.rows.push(valid); f.headers.set(12, valid.block_hash);
    f.advance(60_001);
    expect(await batch.sources(token, block(1000))).toHaveLength(1);
    valid.expires_at = f.now() - 1;
    expect(await batch.sources(token, block(1000))).toEqual([]);
  });

  it('limits scans, indexed token references and old/new source candidates without manufacturing a fallback', async () => {
    const f = fixture(Array.from({ length: 100 }, (_, i) => source(i + 1)));
    const batch = createFreshRecoveryBatch(f.database, rpc, { now: f.now, maxRows: 40, pageSize: 10 });
    const found = await batch.sources(token, block(1000));
    expect(found).toHaveLength(16); expect(found.map(s => s.block.number)).toEqual([40, 39, 38, 37, 36, 35, 34, 33, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(batch.stats()).toMatchObject({ scannedRows: 40, indexedReferences: 16, truncated: true });
    const bytes = createFreshRecoveryBatch(f.database, rpc, { now: f.now, maxBytes: f.rows[0].payload.length - 1 });
    expect(await bytes.sources(token, block(1000))).toEqual([]); expect(bytes.stats().truncated).toBe(true);
  });

  it('coalesces exact immutable inputs but rechecks/rebuilds after TTL or reorg and never caches failures', async () => {
    const f = fixture(), batch = createFreshRecoveryBatch(f.database, rpc, { now: f.now, ttlMs: 20 });
    let loads = 0;
    const load = async () => { loads++; return 'exact-block-input'; };
    expect(await Promise.all([batch.memo('same-hash', load), batch.memo('same-hash', load)])).toEqual(['exact-block-input', 'exact-block-input']);
    expect(loads).toBe(1);
    f.advance(21); await batch.memo('same-hash', load); expect(loads).toBe(2);
    f.reorg(); await batch.memo('same-hash', load); expect(loads).toBe(3);
    let failures = 0; const fail = async () => { failures++; throw Error('unavailable'); };
    await expect(batch.memo('failed', fail)).rejects.toThrow('unavailable');
    await expect(batch.memo('failed', fail)).rejects.toThrow('unavailable'); expect(failures).toBe(2);
  });

  it('bounds concurrent memo work and settled memory, and discards old-generation completions', async () => {
    const f=fixture(),batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,ttlMs:20});
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let loads=0;
    const pending=Array.from({length:300},(_,i)=>batch.memo(`key:${i}`,async()=>{loads++;await gate;return 'small';}));
    // Let epoch queries install their coalesced work before observing capacity.
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    expect(loads).toBe(256);expect(batch.stats().memoEntries).toBe(256);
    release();const settled=await Promise.allSettled(pending);
    expect(settled.filter(value=>value.status==='rejected')).toHaveLength(44);
    expect(batch.stats().memoBytes).toBeLessThanOrEqual(8*1024*1024);
    f.advance(21);
    await batch.memo('large',async()=> 'x'.repeat(2*1024*1024+1));expect(batch.stats().memoEntries).toBe(0);
    let finish!:(value:string)=>void;
    const old=batch.memo('old',()=>new Promise<string>(resolve=>{finish=resolve;}));
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    f.reorg();await batch.memo('new',async()=> 'new-generation');finish('old-generation');await old;
    expect(batch.stats().memoEntries).toBe(1);expect(batch.stats().memoBytes).toBe(Buffer.byteLength(JSON.stringify('new-generation')));
  });

  it('continues after the decoded-byte boundary without losing that row or resetting the earlier index',async()=>{
    const rows=[source(1),source(2,null),source(3,other),source(4,null)],f=fixture(rows);
    const rawBytes=Buffer.byteLength(JSON.stringify({...rows[0].entry,version:1}));
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxDecodedBytes:rawBytes+50,pageSize:10,ttlMs:20});
    expect((await batch.sources(token,block(1000))).map(s=>s.block.number)).toEqual([1]);
    expect(batch.stats()).toMatchObject({cursorBlock:1,cycleScannedRows:1,cycleComplete:false,truncated:true,cycle:1});
    f.advance(21);expect(await batch.sources(other,block(1000))).toEqual([]);
    expect(batch.stats()).toMatchObject({cursorBlock:2,cycleScannedRows:2,cycle:1});
    f.advance(21);expect((await batch.sources(other,block(1000))).map(s=>s.block.number)).toEqual([3]);
    expect((await batch.sources(token,block(1000))).map(s=>s.block.number)).toEqual([1]);
    expect(batch.stats()).toMatchObject({cursorBlock:3,cycleScannedRows:3,cycle:1});
  });

  it('retries a page-byte-budget deferred row in a later slice and eventually finishes the fixed cycle',async()=>{
    const rows=[source(1),source(2),source(3,other)],f=fixture(rows);
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxBytes:rows[0].payload.length+20,ttlMs:20});
    await batch.sources(token,block(1000));expect(batch.stats().cursorBlock).toBe(1);
    f.advance(21);await batch.sources(token,block(1000));expect(batch.stats().cursorBlock).toBe(2);
    f.advance(21);expect((await batch.sources(other,block(1000))).map(s=>s.block.number)).toEqual([3]);
    expect(batch.stats()).toMatchObject({cursorBlock:3,cycleComplete:true,cycleScannedRows:3,cycle:1});
  });

  it('discovers fresh head reads while warming history, revisits changed old envelopes and prunes expired locators',async()=>{
    const f=fixture([source(1),source(2,null),source(3,null)],[block(3000),block(3001)]);
    f.setClock(Date.parse(block(2000).timestamp));
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxRows:2,ttlMs:20});
    await batch.sources(token,block(3000));expect(batch.stats().cursorBlock).toBe(2);
    const newest=source(1701,other);newest.expires_at=f.now()+40;f.rows.push(newest);f.headers.set(1701,newest.block_hash);
    f.advance(21);expect((await batch.sources(other,block(3000))).map(s=>s.block.number)).toEqual([1701]);
    expect(batch.stats()).toMatchObject({tailScannedRows:1,cursorBlock:3,cycle:1});
    // Let the recent row expire so history can use this deliberately tiny budget.
    newest.expires_at=f.now()-1;
    for(let i=0;i<4;i++){f.advance(21);await batch.sources(token,block(3000));}
    expect(batch.stats().cycle).toBeGreaterThanOrEqual(2);
    const older=f.rows.find(row=>row.block_number===2)!;older.expires_at=f.now()+300;older.entry.stateEvidence=source(2,other).entry.stateEvidence;older.payload=encodeFreshEvidence(older.entry);older.payload_bytes=older.payload.length;
    for(let i=0;i<5;i++){f.advance(21);await batch.sources(other,block(3000));}
    expect((await batch.sources(other,block(3000))).map(s=>s.block.number)).toEqual([2]);
    f.advance(301);expect(await batch.sources(other,block(3000))).toEqual([]);
    f.advance(21);await batch.sources(token,block(3000));
    expect(batch.stats().indexedReferences).toBe(1);
    f.reorg();f.advance(21);await batch.sources(token,block(3000));
    expect(batch.stats()).toMatchObject({cycleScannedRows:2,cursorBlock:3,totalScannedRows:2});
  });

  it('reserves progress for history even with the smallest configured row budget and an active recent tail',async()=>{
    const f=fixture([source(1),source(2,other),source(1701,other)],[block(3000),block(3001)]);f.setClock(Date.parse(block(2000).timestamp));
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxRows:1,ttlMs:20});
    await batch.sources(token,block(3000));expect(batch.stats()).toMatchObject({cursorBlock:1,tailScannedRows:0});
    f.advance(21);expect((await batch.sources(other,block(3000))).map(s=>s.block.number)).toEqual([2]);
    expect(batch.stats()).toMatchObject({cursorBlock:2,cycleScannedRows:2,tailScannedRows:0});
  });

  it('reserves decoded and compressed budget for the deferred historical row despite an active tail',async()=>{
    const rows=[source(1),source(2,other),source(1701,other)],f=fixture(rows,[block(3000),block(3001)]);f.setClock(Date.parse(block(2000).timestamp));
    const raw=Buffer.byteLength(JSON.stringify({...rows[0].entry,version:1}));
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxDecodedBytes:Math.floor(raw*1.8),maxBytes:rows[0].payload.length*2,ttlMs:20});
    await batch.sources(token,block(3000));expect(batch.stats()).toMatchObject({cursorBlock:1,tailScannedRows:0});
    f.advance(21);expect((await batch.sources(other,block(3000))).map(s=>s.block.number)).toEqual([2]);
    expect(batch.stats().cursorBlock).toBe(2);
  });

  it('indexes new captured head reads beyond the fixed historical cycle ceiling',async()=>{
    const f=fixture([source(1),source(2,null),source(3,null)],[block(3000),block(3001)]);
    f.setClock(Date.parse(block(2200).timestamp));f.setHead(1000);
    const batch=createFreshRecoveryBatch(f.database,rpc,{now:f.now,maxRows:2,ttlMs:20});
    await batch.sources(token,block(3000));expect(batch.stats()).toMatchObject({cycleCeilingBlock:1000,cursorBlock:2});
    const late=source(2000,other);f.rows.push(late);f.headers.set(2000,late.block_hash);f.setHead(3001);f.advance(21);
    expect((await batch.sources(other,block(3000))).map(s=>s.block.number)).toEqual([2000]);
    expect(batch.stats()).toMatchObject({cycleCeilingBlock:1000,tailScannedRows:1,cursorBlock:3});
    f.advance(21);await batch.sources(other,block(3000));
    f.advance(21);await batch.sources(other,block(3000));expect(batch.stats().cycleCeilingBlock).toBe(3001);
  });
});
