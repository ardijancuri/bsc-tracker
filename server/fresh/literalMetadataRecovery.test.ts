import{readFileSync}from'node:fs';
import{gunzipSync}from'node:zlib';
import{keccak256}from'ethers';
import{describe,it,expect}from'vitest';
import{FRESH_LITERAL_METADATA_AUDIT as audit,recoverFreshLiteralCreationPrecision,type FreshLiteralMetadataInput}from'./literalMetadataRecovery.js';
import{createFreshTemplateMetadataRecovery}from'./templateMetadataRecovery.js';
import type{FreshMetadataCreationContext}from'./constantMetadataRecovery.js';
const original:FreshMetadataCreationContext=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/literal-metadata-creation.json.gz',import.meta.url))).toString());
const number=Number(BigInt(original.block.number)),time=Number(BigInt(original.block.timestamp))*1000;
const fixture=():FreshLiteralMetadataInput=>({chainId:56,tokenAddress:audit.tokenAddress,target:{number:number+1,hash:'0x'+'f'.repeat(64),timestamp:new Date(time+1000).toISOString()},targetTransactionIndex:0,creation:structuredClone(original)});

function executeAuditedConstructor(initcode: string,address:string) {
  const code = Buffer.from(initcode.slice(2), 'hex'), memory = Buffer.alloc(8192), stack: bigint[] = [], storage = new Map<bigint, bigint>();
  const copies: {pc: number; source: number; offset: number; length: number; step:number}[] = [], stores: {pc: number; offset: number; value: bigint; step:number}[] = [];
  const writes: string[] = [], validJumps = new Set<number>(), mask = (1n << 256n) - 1n;
  for (let offset = 0; offset < code.length; offset++) { const op = code[offset]; if (op === 0x5b) validJumps.add(offset); if (op >= 0x60 && op <= 0x7f) offset += op - 0x5f; }
  const pop = () => { if (!stack.length) throw new Error('constructor_stack'); return stack.pop()!; };
  const push = (value: bigint) => { if (stack.length >= 1024) throw new Error('constructor_stack'); stack.push(value & mask); };
  const number = (value: bigint) => { if (value > BigInt(memory.length)) throw new Error('constructor_memory'); return Number(value); };
  const bounds = (offset: number, length: number) => { if (offset + length > memory.length) throw new Error('constructor_memory'); };
  const signed = (value: bigint) => value >= (1n << 255n) ? value - (1n << 256n) : value;
  const word = (value: Buffer) => BigInt(`0x${value.toString('hex') || '0'}`);
  const jump = (destination: bigint) => { const value = number(destination); if (!validJumps.has(value)) throw new Error('constructor_jump'); return value; };
  let pc = 0;
  for (let steps = 1; steps <= 8192; steps++) {
    const op = code[pc++]; let a: bigint, b: bigint, offset: number, length: number;
    if (op >= 0x60 && op <= 0x7f) { const count = op - 0x5f; push(word(code.subarray(pc, pc + count))); pc += count; continue; }
    if (op >= 0x80 && op <= 0x8f) { const value = stack.at(-(op - 0x7f)); if (value === undefined) throw new Error('constructor_stack'); push(value); continue; }
    if (op >= 0x90 && op <= 0x9f) { const index = stack.length - 1 - (op - 0x8f); if (index < 0) throw new Error('constructor_stack'); [stack[index], stack[stack.length - 1]] = [stack.at(-1)!, stack[index]]; continue; }
    switch (op) {
      case 0x01: push(pop() + pop()); break;
      case 0x02: push(pop() * pop()); break;
      case 0x03: a = pop(); b = pop(); push(a - b); break;
      case 0x04: a = pop(); b = pop(); push(b === 0n ? 0n : a / b); break;
      case 0x0a: a = pop(); b = pop(); if (b > 256n) throw new Error('constructor_exponent'); push(a ** b); break;
      case 0x10: a = pop(); b = pop(); push(a < b ? 1n : 0n); break;
      case 0x11: a = pop(); b = pop(); push(a > b ? 1n : 0n); break;
      case 0x12: a = pop(); b = pop(); push(signed(a) < signed(b) ? 1n : 0n); break;
      case 0x14: push(pop() === pop() ? 1n : 0n); break;
      case 0x15: push(pop() === 0n ? 1n : 0n); break;
      case 0x16: push(pop() & pop()); break;
      case 0x17: push(pop() | pop()); break;
      case 0x19: push(~pop()); break;
      case 0x1b: a = pop(); b = pop(); push(a >= 256n ? 0n : b << a); break;
      case 0x1c: a = pop(); b = pop(); push(a >= 256n ? 0n : b >> a); break;
      case 0x20: offset = number(pop()); length = number(pop()); bounds(offset, length); push(BigInt(keccak256(memory.subarray(offset, offset + length)))); break;
      case 0x30: push(BigInt(address)); break;
      case 0x34: push(0n); break;
      case 0x46: push(56n); break;
      case 0x38: push(BigInt(code.length)); break;
      case 0x39: { offset = number(pop()); const source = number(pop()); length = number(pop()); bounds(offset, length); copies.push({pc: pc - 1, source, offset, length,step:steps}); memory.fill(0, offset, offset + length); code.copy(memory, offset, source, source + length); break; }
      case 0x50: pop(); break;
      case 0x51: offset = number(pop()); bounds(offset, 32); push(word(memory.subarray(offset, offset + 32))); break;
      case 0x52: offset = number(pop()); a = pop(); bounds(offset, 32); stores.push({pc: pc - 1, offset, value: a,step:steps}); Buffer.from(a.toString(16).padStart(64, '0'), 'hex').copy(memory, offset); break;
      case 0x54: push(storage.get(pop()) ?? 0n); break;
      case 0x55: a = pop(); b = pop(); storage.set(a, b); writes.push(a.toString()); break;
      case 0x56: pc = jump(pop()); break;
      case 0x57: a = pop(); if (pop() !== 0n) pc = jump(a); break;
      case 0x5b: break;
      case 0x5f: push(0n); break;
      case 0xa3: offset = number(pop()); length = number(pop()); bounds(offset,length); pop(); pop(); pop(); break;
      case 0xf3: offset = number(pop()); length = number(pop()); bounds(offset, length); return { runtime: memory.subarray(offset, offset + length), storage, writes, steps, copies, stores, returnOffset: offset, returnPc: pc - 1 };
      default: throw new Error(`unaudited_constructor_opcode_${op?.toString(16)}`);
    }
  }
  throw new Error('constructor_step_limit');
}

describe('single exact constructor precision proof',()=>{
 it('executes the full canonical constructor independently and reconstructs every immutable runtime word',()=>{
  const x=fixture(),run=executeAuditedConstructor(String(x.creation.transaction.input),x.tokenAddress),result=recoverFreshLiteralCreationPrecision(x)!;
  expect(result.decimals).toBe(18);expect(keccak256(run.runtime)).toBe(audit.runtimeHash);expect(run.returnPc).toBe(audit.returnPc);
  expect(run.copies.at(-1)).toMatchObject({pc:audit.copyPc,source:audit.constructorBytes,offset:run.returnOffset,length:audit.runtimeBytes});
  const afterCopy=run.stores.filter(s=>s.step>run.copies.at(-1)!.step);expect(afterCopy.map(s=>s.offset-run.returnOffset)).toEqual(result.proof.runtime.immutablePatches.map(p=>p.offset));
  for(const p of result.proof.runtime.immutablePatches)expect('0x'+run.runtime.subarray(p.offset,p.offset+32).toString('hex')).toBe(p.value);
  expect(run.runtime.subarray(audit.getterPc,audit.getterPc+audit.getterBytes.length/2).toString('hex')).toBe(audit.getterBytes);
  expect(result).not.toHaveProperty('supplyRaw');expect(result).not.toHaveProperty('price');
 });
 it('rejects wrong chain, contract, failed creation, nonce mismatch and nonzero constructor value',()=>{
  for(const mutate of[(x:any)=>x.chainId=1,(x:any)=>x.tokenAddress='0x'+'1'.repeat(40),(x:any)=>x.creation.receipt.status='0x0',(x:any)=>x.creation.transaction.nonce='0x1',(x:any)=>x.creation.transaction.value='0x1']){const x=fixture();mutate(x);expect(recoverFreshLiteralCreationPrecision(x)).toBeNull();}
 });
 it('rejects altered getter, constructor, argument or appended byte rather than generalizing ERC20 metadata',()=>{
  for(const offset of[0x20,audit.constructorBytes+audit.getterPc+0x16,audit.argumentsOffset+200]){const x=fixture(),b=Buffer.from(String(x.creation.transaction.input).slice(2),'hex');b[offset]^=1;x.creation.transaction.input='0x'+b.toString('hex');x.creation.block.transactions[Number(BigInt(x.creation.transaction.transactionIndex))]=x.creation.transaction;expect(recoverFreshLiteralCreationPrecision(x)).toBeNull();}
  const x=fixture();x.creation.transaction.input+='00';expect(recoverFreshLiteralCreationPrecision(x)).toBeNull();
 });
 it('requires indexed inclusion and prevents a same-block trade before creation',()=>{
  const x=fixture();x.creation.block.transactions[Number(BigInt(x.creation.transaction.transactionIndex))]={...x.creation.transaction,hash:'0x'+'1'.repeat(64)};expect(recoverFreshLiteralCreationPrecision(x)).toBeNull();
  const y=fixture();y.target={number,hash:original.block.hash,timestamp:new Date(time).toISOString()};y.targetTransactionIndex=Number(BigInt(original.transaction.transactionIndex))-1;expect(recoverFreshLiteralCreationPrecision(y)).toBeNull();y.targetTransactionIndex++;expect(recoverFreshLiteralCreationPrecision(y)?.decimals).toBe(18);
  y.target.hash='0x'+'1'.repeat(64);expect(recoverFreshLiteralCreationPrecision(y)).toBeNull();
 });
 it('loads only canonical creation and chain identity, without raw sources, current state or initializer scans',async()=>{
  const x=fixture(),calls:string[]=[],batch:any={memo:async(_k:string,fn:any)=>fn(),sources:async()=>{throw Error('raw_source_forbidden');}},rpc:any=async(m:string)=>{calls.push(m);if(m==='eth_getBlockByNumber')return x.creation.block;if(m==='eth_getTransactionReceipt')return x.creation.receipt;if(m==='eth_chainId')return'0x38';throw Error('unexpected_rpc:'+m);};
  const adapter=createFreshTemplateMetadataRecovery({query:async()=>{throw Error('database_scan_forbidden');}} as any,rpc,batch,{target:x.target,entry:{transaction:{transactionIndex:'0x0'}} as any,anchor:async()=>{throw Error('current_anchor_forbidden');},canonicalHash:async(n:number)=>n===number?original.block.hash:n===x.target.number?x.target.hash:null});
  const result=await adapter.metadata(x.tokenAddress,{protocol:'evm_creation',status:'eligible',tx_hash:original.transaction.hash,block_number:number,block_hash:original.block.hash});
  expect(result?.value.decimals).toBe(18);expect(result?.value.supplyRaw).toBeNull();expect(calls).toEqual(['eth_getBlockByNumber','eth_getTransactionReceipt','eth_chainId']);
 });
 it('rejects creation or target canonicality changes before returning its local proof',async()=>{
  for(const orphan of[number,number+1]){const x=fixture(),rpc:any=async(m:string)=>m==='eth_getBlockByNumber'?x.creation.block:m==='eth_getTransactionReceipt'?x.creation.receipt:'0x38',batch:any={memo:async(_k:string,fn:any)=>fn()};const adapter=createFreshTemplateMetadataRecovery({} as any,rpc,batch,{target:x.target,entry:{transaction:{transactionIndex:'0x0'}} as any,anchor:async()=>{throw Error('forbidden');},canonicalHash:async(n:number)=>n===orphan?'0x'+'1'.repeat(64):n===number?original.block.hash:x.target.hash});
   const work=adapter.metadata(x.tokenAddress,{protocol:'evm_creation',status:'eligible',tx_hash:original.transaction.hash,block_number:number,block_hash:original.block.hash});if(orphan===number)await expect(work).rejects.toThrow('noncanonical');else expect(await work).toBeNull();}
 });
});
