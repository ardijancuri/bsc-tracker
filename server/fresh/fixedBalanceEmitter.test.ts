import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{AbiCoder,Interface,keccak256,solidityPacked}from'ethers';import{describe,it,expect}from'vitest';
import{FRESH_FIXED_BALANCE_EMITTER_AUDIT as audit,classifyFreshFixedBalanceEmitter}from'./fixedBalanceEmitter.js';
import{classifyFreshCreationToken}from'./tokenAuthenticity.js';import type{FreshMetadataCreationContext}from'./constantMetadataRecovery.js';
const contexts:FreshMetadataCreationContext[]=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/fixed-balance-emitter-creations.json.gz',import.meta.url))).toString()),abi=AbiCoder.defaultAbiCoder();
function executeAudit(initcode:string,options:{address:string;caller:string;timestamp?:bigint;calldata?:string;storage?:Map<bigint,bigint>;balance?:bigint}) {
  const code=Buffer.from(initcode.slice(2),'hex'),calldata=Buffer.from((options.calldata??'0x').slice(2),'hex'),memory=Buffer.alloc(65536),stack:bigint[]=[],storage=new Map(options.storage??[]),calls:any[]=[],logs:any[]=[],visited:number[]=[];
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
    visited.push(pc); const op = code[pc++]; let a: bigint, b: bigint, offset: number, length: number;
    if (op >= 0x60 && op <= 0x7f) { const count = op - 0x5f; push(word(code.subarray(pc, pc + count))); pc += count; continue; }
    if (op >= 0x80 && op <= 0x8f) { const value = stack.at(-(op - 0x7f)); if (value === undefined) throw new Error('constructor_stack'); push(value); continue; }
    if (op >= 0x90 && op <= 0x9f) { const index = stack.length - 1 - (op - 0x8f); if (index < 0) throw new Error('constructor_stack'); [stack[index], stack[stack.length - 1]] = [stack.at(-1)!, stack[index]]; continue; }
    switch (op) {
      case 0x01: push(pop() + pop()); break;
      case 0x02: push(pop() * pop()); break;
      case 0x03: a = pop(); b = pop(); push(a - b); break;
      case 0x06: a=pop();b=pop();push(b===0n?0n:a%b);break;
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
      case 0x30: push(BigInt(options.address));break;
      case 0x33:push(BigInt(options.caller));break;
      case 0x35:{offset=number(pop());const out=Buffer.alloc(32);calldata.copy(out,0,offset,offset+32);push(word(out));break;}
      case 0x36:push(BigInt(calldata.length));break;
      case 0x37:{offset=number(pop());const source=number(pop());length=number(pop());bounds(offset,length);memory.fill(0,offset,offset+length);calldata.copy(memory,offset,source,source+length);break;}
      case 0x42:push(options.timestamp??1000n);break;
      case 0x47:push(options.balance??1000n);break;
      case 0x5a:push(10000000n);break;
      case 0x5e:{offset=number(pop());const source=number(pop());length=number(pop());bounds(offset,length);bounds(source,length);Buffer.from(memory.subarray(source,source+length)).copy(memory,offset);break;}
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
      case 0xa3:{offset=number(pop());length=number(pop());bounds(offset,length);const topics=[pop(),pop(),pop()].map(x=>'0x'+x.toString(16).padStart(64,'0'));logs.push({pc:pc-1,topics,data:'0x'+memory.subarray(offset,offset+length).toString('hex')});break;}
      case 0xf1:case 0xfa:{pop();const to=pop(),value=op===0xf1?pop():0n,arg=number(pop()),size=number(pop()),out=number(pop()),outSize=number(pop());bounds(arg,size);bounds(out,outSize);const data='0x'+memory.subarray(arg,arg+size).toString('hex');calls.push({pc:pc-1,kind:op===0xf1?'CALL':'STATICCALL',to:'0x'+to.toString(16).padStart(40,'0'),value:value.toString(),data});memory.fill(0,out,out+outSize);const returned=Buffer.from((op===0xfa?100n:1n).toString(16).padStart(64,'0'),'hex');returned.copy(memory,out,0,Math.min(32,outSize));push(1n);break;}
      case 0x00:return{runtime:Buffer.alloc(0),storage,writes,steps,copies,stores,returnOffset:0,returnPc:pc-1,calls,logs,visited,status:'stop'};
      case 0xfd:offset=number(pop());length=number(pop());bounds(offset,length);return{runtime:Buffer.from(memory.subarray(offset,offset+length)),storage,writes,steps,copies,stores,returnOffset:offset,returnPc:pc-1,calls,logs,visited,status:'revert'};
      case 0xf3: offset = number(pop()); length = number(pop()); bounds(offset, length); return { runtime: memory.subarray(offset, offset + length), storage, writes, steps, copies, stores, returnOffset: offset, returnPc: pc - 1,calls,logs,visited,status:'return' };
      default: throw new Error(`unaudited_constructor_opcode_${op?.toString(16)}`);
    }
  }
  throw new Error('constructor_step_limit');
}

describe('exact pinned fixed-balance event emitters',()=>{
 it.each(contexts.map((context,index)=>({context,index})))('authenticates original canonical creation $index without changing input',({context})=>{const before=JSON.stringify(context),p=classifyFreshCreationToken(context)!;expect(p?.templateId).toBe(audit.id);expect(p?.ledgerAbsent).toBe(true);expect(p.bytecode.runtimeHash).toBe(audit.runtimeHash);expect(p.bytecode.constructorArguments?.immutablePatches).toEqual([]);expect(p.creationEvidence.transaction.input).toBe(context.transaction.input);expect(JSON.stringify(context)).toBe(before);});
 it('independently executes all13 exact constructors, proving literal CODECOPY/RETURN without runtime patches or external calls',()=>{
  for(const c of contexts){const x=executeAudit(String(c.transaction.input),{address:c.receipt.contractAddress!,caller:c.transaction.from}),copy=x.copies.at(-1)!;expect(keccak256(x.runtime)).toBe(audit.runtimeHash);expect(x.runtime.length).toBe(audit.runtimeBytes);expect(x.returnPc).toBe(audit.returnPc);expect(copy).toMatchObject({pc:audit.copyPc,source:audit.constructorBytes,offset:0,length:audit.runtimeBytes});expect(x.stores.filter(s=>s.step>copy.step)).toEqual([]);expect(x.calls).toEqual([]);}
 });
 it('rejects bytecode, identity metadata, precision, supply, range and noncanonical ABI changes instead of normalizing a family',()=>{
  for(const offset of[0,0x2fd,audit.constructorBytes+0x2fb,audit.argumentsOffset,audit.argumentsOffset+64+31,audit.argumentsOffset+96+31,audit.argumentsOffset+128+31,audit.argumentsOffset+192]){const c=structuredClone(contexts[0]),bytes=Buffer.from(String(c.transaction.input).slice(2),'hex');bytes[offset]^=1;c.transaction.input='0x'+bytes.toString('hex');c.block.transactions[Number(BigInt(c.transaction.transactionIndex))]=c.transaction;expect(classifyFreshCreationToken(c)).toBeNull();}
  const c=structuredClone(contexts[0]);c.transaction.input+='00';expect(classifyFreshCreationToken(c)).toBeNull();
 });
 it('requires BSC chain, indexed successful original CREATE, derived address and zero constructor value',()=>{
  expect(classifyFreshFixedBalanceEmitter({chainId:1,...contexts[0]})).toBeNull();
  for(const mutate of[(c:any)=>c.receipt.status='0x0',(c:any)=>c.receipt.blockHash='0x'+'1'.repeat(64),(c:any)=>c.transaction.nonce='0xffffff',(c:any)=>c.transaction.value='0x1',(c:any)=>c.transaction.to='0x'+'1'.repeat(40),(c:any)=>c.receipt.contractAddress='0x'+'2'.repeat(40),(c:any)=>c.transaction.transactionIndex='0x0',(c:any)=>c.block.transactions[Number(BigInt(c.transaction.transactionIndex))]={...c.transaction,hash:'0x'+'2'.repeat(64)}]){const c=structuredClone(contexts[0]);mutate(c);expect(classifyFreshCreationToken(c)).toBeNull();}
 });
 it('has local fake balance/getters and log-only approvals/transfers, never a token ledger or external balance delegation',()=>{
  const c=contexts[0],created=executeAudit(String(c.transaction.input),{address:c.receipt.contractAddress!,caller:c.transaction.from}),code='0x'+created.runtime.toString('hex'),account='0x'+'2'.repeat(40),recipient='0x'+'3'.repeat(40),outsider='0x'+'1'.repeat(40),token=new Interface(['function name()view returns(string)','function symbol()view returns(string)','function decimals()view returns(uint8)','function totalSupply()view returns(uint256)','function balanceOf(address)view returns(uint256)','function allowance(address,address)view returns(uint256)','function approve(address,uint256)returns(bool)','function transferFrom(address,address,uint256)returns(bool)']);
  for(const [method,args]of[['name',[]],['symbol',[]],['decimals',[]],['totalSupply',[]],['balanceOf',[account]],['allowance',[account,recipient]],['approve',[recipient,7n]],['transferFrom',[account,recipient,7n]]] as const){const x=executeAudit(code,{address:c.receipt.contractAddress!,caller:outsider,storage:created.storage,calldata:token.encodeFunctionData(method,args)});expect(x.writes).toEqual([]);expect(x.calls).toEqual([]);if(method==='balanceOf'){expect(x.status).toBe('revert');expect(x.runtime.toString('hex').endsWith('12')).toBe(true);}else expect(x.status).toBe('return');if(method==='approve'||method==='transferFrom')expect(x.logs).toHaveLength(1);}
  const packed='0xa9059cbb'+account.slice(2)+recipient.slice(2)+'000000000000000000000007',x=executeAudit(code,{address:c.receipt.contractAddress!,caller:outsider,storage:created.storage,calldata:packed});expect(x.logs).toHaveLength(1);expect(x.writes).toEqual([]);expect(x.calls).toEqual([]);
  const values=[];for(const timestamp of[1000n,1001n]){const storage=new Map(created.storage);storage.set(4n,17n);const y=executeAudit(code,{address:c.receipt.contractAddress!,caller:outsider,storage,calldata:token.encodeFunctionData('balanceOf',[account]),timestamp}),expected=(BigInt(keccak256(solidityPacked(['uint256','address'],[timestamp,account])))%170n+1n)*10n**18n/10n;expect(BigInt('0x'+y.runtime.toString('hex'))).toBe(expected);expect(y.writes).toEqual([]);expect(y.calls).toEqual([]);values.push(expected);}expect(values[0]).not.toBe(values[1]);
 });
 it('only owner withdrawal entrypoints reach the three audited external calls',()=>{
  const c=contexts[0],created=executeAudit(String(c.transaction.input),{address:c.receipt.contractAddress!,caller:c.transaction.from}),code='0x'+created.runtime.toString('hex'),outsider='0x'+'1'.repeat(40),recipient='0x'+'3'.repeat(40),external='0x'+'4'.repeat(40),callPcs:number[]=[];
  for(const [selector,values]of[['0x25e16063',[recipient]],['0x3aeac4e1',[external,recipient]]]as const)for(const who of[outsider,c.transaction.from]){const x=executeAudit(code,{address:c.receipt.contractAddress!,caller:who,storage:created.storage,calldata:selector+abi.encode(values.length===1?['address']:['address','address'],values).slice(2)});expect(x.writes).toEqual([]);if(who===outsider){expect(x.status).toBe('revert');expect(x.calls).toEqual([]);}else{expect(x.status).toBe('stop');callPcs.push(...x.calls.map(x=>x.pc));if(values.length===1)expect(x.calls[0]).toMatchObject({to:recipient,value:'1000',data:'0x'});else{expect(x.calls[0]).toMatchObject({to:external,kind:'STATICCALL'});expect(x.calls[0].data).toBe('0x70a08231'+c.receipt.contractAddress!.slice(2).padStart(64,'0'));expect(x.calls[1].data).toBe('0xa9059cbb'+abi.encode(['address','uint256'],[recipient,100n]).slice(2));}}}
  expect(callPcs).toEqual(audit.withdrawalCalls.map(x=>x.pc));
 });
});
