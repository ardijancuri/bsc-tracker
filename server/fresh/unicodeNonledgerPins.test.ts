import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {keccak256} from 'ethers';
import {classifyFreshCreationToken,FRESH_IMMUTABLE_NONLEDGER_TEMPLATES} from './tokenAuthenticity.js';
import {executeSyntheticAudit} from './syntheticBatchEvm.fixture.js';

const fixtures=()=>JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/unicode-nonledger-pins.json.gz',import.meta.url))).toString()) as any[];
const indices=[{runtimeOffset:847,argumentWord:0},{runtimeOffset:183,argumentWord:1},{runtimeOffset:144,argumentWord:2},
  {runtimeOffset:589,argumentWord:3},{runtimeOffset:550,argumentWord:4},{runtimeOffset:458,argumentWord:5}];
const word=(address:string)=>'0x'+'0'.repeat(24)+address.slice(2);

describe('two exact immutable nonledger creation pins',()=>{
 for(const token of ['0xce7be956b390a9504a2d0f23876f40645fabf5b5','0x46d3c430e7e8515e06724b9f4b16d1acb39e896a']){
  const fixture=()=>fixtures().find(f=>f.token===token)!;
  it(`independently reconstructs the entire canonical constructor runtime for ${token}`,()=>{
    const f=fixture(),c=f.creation,pin=FRESH_IMMUTABLE_NONLEDGER_TEMPLATES.find(t=>t.initcode===c.transaction.input)!;
    expect(pin).toBeDefined();expect(pin.immutablePatches).toEqual(indices);
    const out=executeSyntheticAudit(c.transaction.input,{address:token,caller:c.transaction.from,timestamp:BigInt(c.block.timestamp)});
    expect(out.status).toBe('return');expect(out.returnPc).toBe(216);expect(out.calls).toEqual([]);expect(out.writes).toEqual([]);
    expect('0x'+out.runtime.toString('hex')).toBe(f.runtime);expect(keccak256(out.runtime)).toBe(pin.runtimeHash);
    const proof=classifyFreshCreationToken(c)!;expect(proof.classification).toBe('proven_nonledger_event_emitter');
    expect(proof.templateId).toBe(pin.id);expect(proof.creationEvidence.receipt.contractAddress).toBe(token);
    expect(proof.bytecode.constructorArguments?.immutablePatches).toEqual(indices);
  });
  it(`proves all code paths lack ledger access or external effects for ${token}`,()=>{
    const f=fixture(),runtime=Buffer.from(f.runtime.slice(2),'hex'),end=runtime.length-runtime.readUInt16BE(runtime.length-2)-2;
    expect(end).toBe(987);expect(runtime[end-1]).toBe(0xfe);
    let logs=0;for(let pc=0;pc<runtime.length;pc++){
      const op=runtime[pc];
      if(pc<end){expect([0x54,0x55,0x5d,0xf0,0xf1,0xf2,0xf4,0xf5,0xfa,0xff]).not.toContain(op);if(op===0xa3)logs++;}
      else expect(op).not.toBe(0x5b);
      if(op>=0x60&&op<=0x7f){const start=pc;pc+=op-0x5f;if(start<end)expect(pc).toBeLessThan(end);}
    }
    expect(logs).toBeGreaterThan(0);
  });
  it(`checks six distinct immutable arguments rather than relying on equal name/symbol words for ${token}`,()=>{
    const f=fixture(),raw=Buffer.from(f.creation.transaction.input.slice(2),'hex');
    const args=[Buffer.from('0'.repeat(24)+'1'.repeat(40),'hex'),Buffer.concat([Buffer.from('ALPHA'),Buffer.alloc(27)]),Buffer.from('0'.repeat(63)+'5','hex'),
      Buffer.concat([Buffer.from('BETA'),Buffer.alloc(28)]),Buffer.from('0'.repeat(63)+'4','hex'),Buffer.from('0'.repeat(63)+'7','hex')];
    const input='0x'+Buffer.concat([raw.subarray(0,1255),...args]).toString('hex');
    const out=executeSyntheticAudit(input,{address:token,caller:f.creation.transaction.from,timestamp:BigInt(f.creation.block.timestamp)});
    expect(out.status).toBe('return');for(const patch of indices){expect(out.runtime[patch.runtimeOffset-1]).toBe(0x7f);expect(out.runtime.subarray(patch.runtimeOffset,patch.runtimeOffset+32)).toEqual(args[patch.argumentWord]);}
    const changed=structuredClone(f.creation);changed.transaction.input=input;changed.block.transactions[Number(BigInt(changed.transaction.transactionIndex))].input=input;
    expect(classifyFreshCreationToken(changed)).toBeNull();
  });
  it(`rejects changed code, args and transaction/receipt/block identity for ${token}`,()=>{
    const mutations:((c:any)=>void)[]=[c=>c.block.hash='0x'+'1'.repeat(64),c=>c.receipt.contractAddress='0x'+'1'.repeat(40),
      c=>c.receipt.status='0x0',c=>c.transaction.value='0x1',c=>c.transaction.nonce='0x123',
      c=>c.transaction.blockHash='0x'+'1'.repeat(64),c=>c.receipt.transactionHash='0x'+'1'.repeat(64),
      c=>c.block.transactions[Number(BigInt(c.transaction.transactionIndex))].hash='0x'+'1'.repeat(64),
      c=>{const input=c.transaction.input.slice(0,-2)+'13';c.transaction.input=input;c.block.transactions[Number(BigInt(c.transaction.transactionIndex))].input=input;},
      c=>{const input=c.transaction.input.slice(0,600)+'ff'+c.transaction.input.slice(602);c.transaction.input=input;c.block.transactions[Number(BigInt(c.transaction.transactionIndex))].input=input;}];
    for(const mutate of mutations){const c=structuredClone(fixture().creation);mutate(c);expect(classifyFreshCreationToken(c)).toBeNull();}
  });
  it(`can emit an arbitrary third-party transfer log without moving storage for ${token}`,()=>{
    const f=fixture(),raw=Buffer.from(f.creation.transaction.input.slice(2),'hex'),controller='0x'+raw.subarray(1255+12,1255+32).toString('hex');
    const from='0x'+'2'.repeat(40),to='0x'+'3'.repeat(40),amount=123n;
    const calldata='0xa9059cbb'+word(from).slice(2)+word(to).slice(2)+amount.toString(16).padStart(64,'0');
    const out=executeSyntheticAudit(f.runtime,{address:token,caller:controller,calldata});
    expect(out.writes).toEqual([]);expect(out.calls).toEqual([]);expect(out.logs).toHaveLength(1);
    expect(out.logs[0].topics).toEqual(['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',word(from),word(to)]);
    expect(out.logs[0].data).toBe('0x'+amount.toString(16).padStart(64,'0'));
    const denied=executeSyntheticAudit(f.runtime,{address:token,caller:from,calldata});expect(denied.logs).toEqual([]);expect(denied.writes).toEqual([]);
  });
 }
});
