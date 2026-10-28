import{describe,it,expect}from'vitest';import{getCreateAddress,keccak256}from'ethers';
import{classifyFreshPinnedCreationToken as classifyFreshCreationToken,classifyFreshCreationToken as classifyAuditedFamily}from'./tokenAuthenticity.js';import{FRESH_RANKING_NONLEDGER_CREATIONS}from'./rankingNonledgerCreation.fixture.js';
import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';
import{FRESH_RANKING_IMMUTABLE_NONLEDGER_TEMPLATES,FRESH_RANKING_LITERAL_NONLEDGER_TEMPLATES}from'./rankingNonledgerTemplates.js';import type{FreshBlock,FreshTransaction,FreshReceipt}from'./capture.js';
const fixtures=FRESH_RANKING_NONLEDGER_CREATIONS,templates=[...FRESH_RANKING_IMMUTABLE_NONLEDGER_TEMPLATES,...FRESH_RANKING_LITERAL_NONLEDGER_TEMPLATES];
function context(index:number){const saved=structuredClone(fixtures[index]),transaction=saved.transaction as unknown as FreshTransaction,receipt=saved.receipt as unknown as FreshReceipt,transactions=saved.block.transactionHashes.map(hash=>({hash})as FreshTransaction);transactions[Number(BigInt(transaction.transactionIndex))]=transaction;return{transaction,receipt,block:{number:saved.block.number,hash:saved.block.hash,parentHash:saved.block.parentHash,timestamp:saved.block.timestamp,transactions}as FreshBlock};}
function instructions(runtime:Buffer,end:number){const out:{pc:number;op:number}[]=[];for(let pc=0;pc<end;pc++){out.push({pc,op:runtime[pc]});if(runtime[pc]>=0x60&&runtime[pc]<=0x7f)pc+=runtime[pc]-0x5f;expect(pc).toBeLessThan(end);}return out;}
describe('individually pinned nonledger creators behind false ranking dependencies',()=>{
 it('pins the two additional complete creations without admitting the storage-backed 7607 contract',()=>{
  for(const token of['0x59c6a2470c34c98979b8dcf1c46a60a9515c17ff','0x691cdd7ea2cd940e3e0880e67ffaf5ac25092603'])expect(fixtures.some(f=>f.token===token)).toBe(true);
  expect(fixtures.some(f=>String(f.token)==='0x7607f11b59982fb4b91faf08a23d423409a268ac')).toBe(false);
  const index=fixtures.findIndex(f=>f.token==='0x59c6a2470c34c98979b8dcf1c46a60a9515c17ff'),template=FRESH_RANKING_IMMUTABLE_NONLEDGER_TEMPLATES.find(t=>t.id==='immutable_59c6a247_log_emitter_v1')!;
  for(let word=0;word<6;word++){const c=context(index),bytes=Buffer.from(String(c.transaction.input).slice(2),'hex');bytes[template.argumentsOffset+word*32+31]^=1;c.transaction.input='0x'+bytes.toString('hex');expect(classifyFreshCreationToken(c)).toBeNull();}
 });
 it.each(fixtures.map((saved,index)=>({saved,index})))('binds complete canonical creation and observed runtime for $saved.token',({saved,index})=>{
  const template=templates.find(t=>t.initcode===saved.transaction.input)!;expect(template).toBeTruthy();const proof=classifyFreshCreationToken(context(index));expect(proof).toMatchObject({classification:'proven_nonledger_event_emitter',ledgerAbsent:true,templateId:template.id,creationEvidence:{receipt:{contractAddress:saved.token}},bytecode:{initcodeHash:keccak256(saved.transaction.input),runtimeHash:keccak256(saved.runtime)}});
  expect(proof?.creationEvidence.transaction.input).toBe(saved.transaction.input);expect(getCreateAddress({from:saved.transaction.from,nonce:saved.transaction.nonce}).toLowerCase()).toBe(saved.token);expect(proof?.bytecode.runtimeBytes).toBe((saved.runtime.length-2)/2);
 });
 it.each(fixtures.map((saved,index)=>({saved,index})))('proves every executable opcode cannot read/write a ledger or call one for $saved.token',({saved})=>{
  const template=templates.find(t=>t.initcode===saved.transaction.input)!,runtime=Buffer.from(saved.runtime.slice(2),'hex'),end='unreachableDataStart'in template?template.unreachableDataStart:template.metadataStart,ops=instructions(runtime,end),forbidden=new Set([0x54,0x55,0x5c,0x5d,0xf0,0xf1,0xf2,0xf4,0xf5,0xfa,0xff]);
  expect(ops.at(-1)).toEqual({pc:end-1,op:0xfe});expect(runtime.subarray(end).includes(0x5b)).toBe(false);expect(ops.some(x=>forbidden.has(x.op))).toBe(false);expect(ops.some(x=>x.op===0xa3)).toBe(true);
 });
 it.each(fixtures.map((saved,index)=>({saved,index})))('rejects modified initcode, arguments, metadata and runtime for $saved.token',({saved,index})=>{
  const template=templates.find(t=>t.initcode===saved.transaction.input)!;for(const offset of[0,16,template.runtimeOffset,template.runtimeOffset+100,(saved.transaction.input.length-2)/2-1]){const c=context(index),bytes=Buffer.from(String(c.transaction.input).slice(2),'hex');bytes[offset]^=1;c.transaction.input='0x'+bytes.toString('hex');expect(classifyFreshCreationToken(c)).toBeNull();}
  for(const input of[saved.transaction.input+'00',saved.transaction.input.slice(0,-2),saved.runtime]){const c=context(index);c.transaction.input=input;expect(classifyFreshCreationToken(c)).toBeNull();}
 });
 it.each(fixtures.map((saved,index)=>({saved,index})))('rejects false canonical context and failed creation for $saved.token',({index})=>{
  for(const mutate of[(c:ReturnType<typeof context>)=>{c.receipt.status='0x0';},(c:ReturnType<typeof context>)=>{c.receipt.contractAddress='0x'+'1'.repeat(40);},(c:ReturnType<typeof context>)=>{c.transaction.value='0x1';},(c:ReturnType<typeof context>)=>{c.block.transactions[Number(BigInt(c.transaction.transactionIndex))]={...c.transaction,input:'0x00'};}]){const c=context(index);mutate(c);expect(classifyFreshCreationToken(c)).toBeNull();}
 });
 it.each(FRESH_RANKING_LITERAL_NONLEDGER_TEMPLATES)('executes the exact short literal constructor for $id',template=>{
  const init=Buffer.from(template.initcode.slice(2),'hex'),stack:bigint[]=[],memory=Buffer.alloc(4096);let pc=0,steps=0,result:Buffer|undefined;const pop=()=>{if(!stack.length)throw Error('stack');return stack.pop()!;};
  while(++steps<32){const op=init[pc++];if(op>=0x60&&op<=0x7f){const n=op-0x5f;stack.push(BigInt('0x'+init.subarray(pc,pc+n).toString('hex')));pc+=n;continue;}if(op>=0x80&&op<=0x8f){stack.push(stack.at(-(op-0x7f))!);continue;}switch(op){case 0x34:case 0x5f:stack.push(0n);break;case 0x15:stack.push(pop()===0n?1n:0n);break;case 0x50:pop();break;case 0x52:{const at=Number(pop()),value=pop();Buffer.from(value.toString(16).padStart(64,'0'),'hex').copy(memory,at);break;}case 0x57:{const to=Number(pop()),condition=pop();if(condition){expect(init[to]).toBe(0x5b);pc=to;}break;}case 0x5b:break;case 0x39:{const at=Number(pop()),source=Number(pop()),n=Number(pop());expect(source).toBe(28);expect(n).toBe(template.runtimeBytes);init.copy(memory,at,source,source+n);break;}case 0xf3:{const at=Number(pop()),n=Number(pop());expect(pc-1).toBe(26);result=Buffer.from(memory.subarray(at,at+n));break;}default:throw Error('unexpected_constructor_opcode_'+op);}if(result)break;}
  expect(steps).toBe(17);expect(keccak256(result!)).toBe(template.runtimeHash);expect(result).toEqual(init.subarray(28));
 });
 it('pins unreachable literal text separately from executable instructions',()=>{for(const template of FRESH_RANKING_LITERAL_NONLEDGER_TEMPLATES.filter(t=>'unreachableDataStart'in t)){const runtime=Buffer.from(template.initcode.slice(2+56),'hex');expect(template.unreachableDataStart).toBe(1585);expect(template.metadataStart).toBeGreaterThan(template.unreachableDataStart);expect(runtime[1584]).toBe(0xfe);expect(runtime.subarray(1585).includes(0x5b)).toBe(false);}});
});

const recurring=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/recurring-nonledger-creations.json.gz',import.meta.url))).toString()).creations as({token:string;transaction:FreshTransaction;receipt:FreshReceipt;block:FreshBlock;code:string})[];
const recurringContext=(index:number)=>structuredClone(recurring[index]);
const updateInput=(c:ReturnType<typeof recurringContext>,bytes:Buffer)=>{c.transaction.input='0x'+bytes.toString('hex');c.block.transactions[Number(BigInt(c.transaction.transactionIndex))]=c.transaction;};
describe('audited stateless code families with variable metadata',()=>{
 it.each(recurring.map((saved,index)=>({saved,index})))('authenticates the actual unpinned creation and complete returned runtime for $saved.token',({saved,index})=>{
  expect(classifyFreshCreationToken(recurringContext(index))).toBeNull();const proof=classifyAuditedFamily(recurringContext(index));
  expect(proof).toMatchObject({classification:'proven_nonledger_event_emitter',ledgerAbsent:true,creationEvidence:{receipt:{contractAddress:saved.token}},bytecode:{initcodeHash:keccak256(String(saved.transaction.input)),runtimeHash:keccak256(saved.code)}});
  expect(proof?.templateId).toBe(saved.code.length===2+1667*2?'audited_literal_stateless_emitter_family_v1':'audited_immutable_stateless_emitter_family_v1');
 });
 it.each(recurring.map((saved,index)=>({saved,index})))('requires canonical complete CREATE, original receipt and BSC context for $saved.token',({index})=>{
  const mutations=[(c:ReturnType<typeof recurringContext>)=>{c.receipt.status='0x0';},(c:ReturnType<typeof recurringContext>)=>{c.transaction.value='0x1';},
   (c:ReturnType<typeof recurringContext>)=>{c.transaction.chainId='0x1';},(c:ReturnType<typeof recurringContext>)=>{c.receipt.contractAddress='0x'+'1'.repeat(40);},
   (c:ReturnType<typeof recurringContext>)=>{c.block.hash='0x'+'1'.repeat(64);},(c:ReturnType<typeof recurringContext>)=>{c.transaction.to=c.token;},
   (c:ReturnType<typeof recurringContext>)=>{c.block.transactions[Number(BigInt(c.transaction.transactionIndex))]={...c.transaction,input:'0x00'};}];
  for(const change of mutations){const c=recurringContext(index);change(c);expect(classifyAuditedFamily(c)).toBeNull();}
  for(const append of['00','5b55f1']){const c=recurringContext(index);updateInput(c,Buffer.from(String(c.transaction.input).slice(2)+append,'hex'));expect(classifyAuditedFamily(c)).toBeNull();}
 });
 it('allows only canonical immutable data while keeping every constructor and executable byte exact',()=>{
  for(const index of[0,1]){const original=recurringContext(index),proof=classifyAuditedFamily(original)!,args=proof.bytecode.constructorArguments!;
   for(const[relative,value]of[[31,0xaa],[32,0x42],[128+31,0x03],[160+31,0x06]]){const c=recurringContext(index),bytes=Buffer.from(String(c.transaction.input).slice(2),'hex');bytes[args.offset+relative]=value;
    // A shorter symbol also needs canonical zero padding.
    if(relative===159)bytes.fill(0,args.offset+96+value,args.offset+128);updateInput(c,bytes);
    const changed=classifyAuditedFamily(c);expect(changed?.templateId).toBe('audited_immutable_stateless_emitter_family_v1');expect(changed?.bytecode.constructorArguments?.hash).toBe(keccak256(bytes.subarray(args.offset)));
   }
   for(const at of[0,55,154,216,255,256,350,args.offset-1]){const c=recurringContext(index),bytes=Buffer.from(String(c.transaction.input).slice(2),'hex');bytes[at]^=1;updateInput(c,bytes);expect(classifyAuditedFamily(c)).toBeNull();}
   for(const relative of[0,64,128,160]){const c=recurringContext(index),bytes=Buffer.from(String(c.transaction.input).slice(2),'hex');bytes[args.offset+relative]=1;updateInput(c,bytes);expect(classifyAuditedFamily(c)).toBeNull();}
  }
 });
 it('keeps literal metadata JUMPDEST bytes unreachable, even when IPFS data resembles state writes or calls',()=>{
  for(const index of[2,3]){const c=recurringContext(index),bytes=Buffer.from(String(c.transaction.input).slice(2),'hex');bytes.fill(0x5b,28+1614+10,28+1614+42);bytes[28+1614+10]=0x55;bytes[28+1614+11]=0xf1;updateInput(c,bytes);
   expect(classifyAuditedFamily(c)?.templateId).toBe('audited_literal_stateless_emitter_family_v1');
   for(const offset of[0,16,26,28,28+100,28+500,28+1000,28+1613,28+1666]){const changed=recurringContext(index),raw=Buffer.from(String(changed.transaction.input).slice(2),'hex');raw[offset]^=1;updateInput(changed,raw);expect(classifyAuditedFamily(changed)).toBeNull();}
  }
 });
 it('rejects storage, external balance lookup, delegation, constructor effects and changed branch/selector bytes',()=>{
  for(const index of[0,1,2,3])for(const opcode of[0x54,0x55,0x5c,0x5d,0x31,0x3b,0x3c,0x3f,0xf0,0xf1,0xf2,0xf4,0xf5,0xfa,0xff]){
   const c=recurringContext(index),bytes=Buffer.from(String(c.transaction.input).slice(2),'hex'),offset=index<2?256:28;bytes[offset]=opcode;updateInput(c,bytes);expect(classifyAuditedFamily(c)).toBeNull();
  }
 });
});
