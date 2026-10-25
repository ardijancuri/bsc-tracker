import{createHash}from'node:crypto';import{describe,it,expect,vi}from'vitest';import{MarketDecimal}from'../nodeMarketMath.js';
import{createFreshImportedMetadataRecovery,freshImportedMetadataMatchesState,FRESH_IMPORTED_METADATA_MAX_BYTES,FRESH_IMPORTED_METADATA_MAX_ROWS,type FreshImportedMetadataIO}from'./importedMetadata.js';
const token='0x'+'1'.repeat(40),h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function fixture(patch:Record<string,unknown>={},artifactPatch:Record<string,unknown>={}){
 const target={number:100,hash:h(100),timestamp:'2026-10-23T20:00:00.000Z'},row:any={tokenAddress:token,blockNumber:target.number,blockHash:target.hash,timestamp:'2026-10-23T20:00:00+00:00',
  decimals:9,totalSupplyRaw:'100000000000000000000',supply:'100000000000',header:{number:'0x64',hash:target.hash,timestamp:'0x'+(Date.parse(target.timestamp)/1000).toString(16)},...patch};
 const raw:any={version:1,chainId:56,source:'node_market_token_evidence',readOnly:true,exportedAt:'2026-10-23T20:30:00.000Z',rows:[row],...artifactPatch};
 const memory={bytes:Buffer.from(JSON.stringify(raw)),stamp:'original',missing:false},expected=sha(memory.bytes);
 const io:FreshImportedMetadataIO={identity:vi.fn(async()=>{if(memory.missing)throw Error('missing');return{size:memory.bytes.length,key:memory.stamp};}),read:vi.fn(async()=>memory.bytes)};
 const canonicalHash=vi.fn(async()=>h(100)),options={file:'verified-private-metadata.json',sha256:expected,io,canonicalHash,environment:{}};
 return{raw,row,target,memory,expected,io,canonicalHash,options,recovery:createFreshImportedMetadataRecovery(options)};
}
describe('pinned typed original metadata recovery',()=>{
 it('is disabled without complete server configuration and does not access files or canonical state',async()=>{
  const f=fixture();for(const config of[{}, {FRESH_RECOVERY_METADATA_FILE:'private.json'},{FRESH_RECOVERY_METADATA_SHA256:f.expected}]){
   const recovery=createFreshImportedMetadataRecovery({io:f.io,canonicalHash:f.canonicalHash,environment:config});expect(await recovery.metadata(token,f.target)).toBeNull();
  }expect(f.io.identity).not.toHaveBeenCalled();expect(f.canonicalHash).not.toHaveBeenCalled();
 });
 it('returns exact scalar metadata with distinct provenance and never fabricates ABI calls or identity',async()=>{
  const f=fixture(),result=await f.recovery.metadata(token,f.target);expect(result?.value).toEqual({address:token,name:null,symbol:null,decimals:9,supplyRaw:f.row.totalSupplyRaw,block:f.target});
  expect(result?.proof).toMatchObject({version:1,kind:'imported_pinned_token_metadata',tokenAddress:token,target:f.target,source:{version:1,chainId:56,table:'node_market_token_evidence',readOnly:true,exportSha256:f.expected,exportedAt:f.raw.exportedAt},observation:{timestamp:f.target.timestamp,header:f.row.header}});
  expect(result?.proof.source.rowSha256).toMatch(/^[\da-f]{64}$/);expect(JSON.stringify(result)).not.toMatch(/stateEvidence|eth_call|313ce567|18160ddd/);
 });
 it('caches only the immutable artifact, checks its identity on every use, and canonicality after loading on every use',async()=>{
  const f=fixture();f.canonicalHash.mockImplementation(async()=>{expect(f.io.read).toHaveBeenCalledOnce();return h(100);});
  const[a,b]=await Promise.all([f.recovery.metadata(token,f.target),f.recovery.metadata(token,f.target)]);expect(a).toEqual(b);expect(f.io.read).toHaveBeenCalledOnce();expect(f.canonicalHash).toHaveBeenCalledTimes(2);
  expect(await f.recovery.metadata(token,f.target)).toEqual(a);expect(f.io.read).toHaveBeenCalledOnce();expect(f.canonicalHash).toHaveBeenCalledTimes(3);
  f.canonicalHash.mockResolvedValue(h(9));expect(await f.recovery.metadata(token,f.target)).toBeNull();
 });
 it('revalidates a prior proof from the original artifact, rejects tampering and does not trust an imported serialized proof by itself',async()=>{
  const f=fixture(),proof=(await f.recovery.metadata(token,f.target))!.proof;
  expect((await f.recovery.metadata(token,f.target,proof))?.proof).toEqual(proof);
  for(const patch of[{decimals:18},{supplyRaw:'0'},{source:{...proof.source,rowSha256:'0'.repeat(64)}},{observation:{...proof.observation,supply:'0'}}])expect(await f.recovery.metadata(token,f.target,{...proof,...patch})).toBeNull();
  const empty=fixture({}, {rows:[]});expect(await empty.recovery.metadata(token,empty.target,proof)).toBeNull();
 });
 it('reloads changed file identities and fails closed on missing, corrupt, wrong-digest or changing artifacts',async()=>{
  const f=fixture();expect(await f.recovery.metadata(token,f.target)).not.toBeNull();f.memory.missing=true;expect(await f.recovery.metadata(token,f.target)).toBeNull();
  f.memory.missing=false;f.memory.stamp='mutated';f.memory.bytes=Buffer.from(JSON.stringify({...f.raw,chainId:1}));expect(await f.recovery.metadata(token,f.target)).toBeNull();
  const g=fixture();expect(await createFreshImportedMetadataRecovery({...g.options,sha256:'0'.repeat(64)}).metadata(token,g.target)).toBeNull();
  const j=fixture();j.io.read=vi.fn(async()=>{j.memory.stamp='changed-during-read';return j.memory.bytes;});expect(await createFreshImportedMetadataRecovery(j.options).metadata(token,j.target)).toBeNull();
 });
 it.each([{version:2},{chainId:1},{source:'tokens'},{readOnly:false},{rows:{}},{exportedAt:'2026-10-23T19:00:00.000Z'},{exportedAt:'invalid'}])('rejects false source/version/export context %j',async patch=>{
  const f=fixture({},patch);expect(await f.recovery.metadata(token,f.target)).toBeNull();
 });
 it('rejects foreign token/height/hash/time and malformed header identity, including same values from another block',async()=>{
  const f=fixture();for(const[targetToken,target]of[[h(1).slice(0,42),f.target],[token,{...f.target,number:101}],[token,{...f.target,hash:h(9)}],[token,{...f.target,timestamp:'2026-10-23T20:00:01.000Z'}]]as const)expect(await f.recovery.metadata(targetToken,target)).toBeNull();
  for(const patch of[{blockNumber:100.1},{blockHash:h(9)},{timestamp:'2026-10-23T20:00:00.001Z'},{timestamp:'2026-02-31T20:00:00Z'},
   {header:{...f.row.header,number:'0x65'}},{header:{...f.row.header,hash:h(9)}},{header:{...f.row.header,timestamp:'0x1'}},{header:{...f.row.header,number:'0x064'}}]){
   const g=fixture(patch);expect(await g.recovery.metadata(token,g.target)).toBeNull();
  }
 });
 it.each([{decimals:-1},{decimals:37},{decimals:1.5},{totalSupplyRaw:100},{totalSupplyRaw:'1e20'},{totalSupplyRaw:'1.5'},{totalSupplyRaw:'-1'},
  {totalSupplyRaw:String(1n<<256n)},{totalSupplyRaw:'01'},{supply:100},{supply:'-1'},{supply:'1e11'},{supply:'1'},{supply:'9'.repeat(257)}])('rejects unsupported scalar values or contradictory exact algebra %j',async patch=>{
  const f=fixture(patch);expect(await f.recovery.metadata(token,f.target)).toBeNull();
 });
 it('accepts observed zero precision/zero supply and exact uint256-sized scalars without floating-point loss',async()=>{
  for(const[decimals,raw]of[[0,0n],[0,9007199254740993n],[36,(1n<<256n)-1n]]as const){const f=fixture({decimals,totalSupplyRaw:String(raw),supply:MarketDecimal.raw(raw,decimals).text()});expect((await f.recovery.metadata(token,f.target))?.value).toMatchObject({decimals,supplyRaw:String(raw)});}
 });
 it('permits identical duplicates but rejects conflicting source rows even when both supplies are internally consistent',async()=>{
  const f=fixture();f.raw.rows.push(structuredClone(f.row));f.memory.bytes=Buffer.from(JSON.stringify(f.raw));const same=createFreshImportedMetadataRecovery({...f.options,sha256:sha(f.memory.bytes)});expect(await same.metadata(token,f.target)).not.toBeNull();
  const g=fixture();g.raw.rows.push({...g.row,decimals:18,supply:'100'});g.memory.bytes=Buffer.from(JSON.stringify(g.raw));expect(await createFreshImportedMetadataRecovery({...g.options,sha256:sha(g.memory.bytes)}).metadata(token,g.target)).toBeNull();
 });
 it('bounds row/file work and rejects oversized sources before reading them',async()=>{
  const f=fixture();f.raw.rows=Array(FRESH_IMPORTED_METADATA_MAX_ROWS+1).fill(f.row);f.memory.bytes=Buffer.from(JSON.stringify(f.raw));expect(await createFreshImportedMetadataRecovery({...f.options,sha256:sha(f.memory.bytes)}).metadata(token,f.target)).toBeNull();
  const g=fixture();g.io.identity=vi.fn(async()=>({size:FRESH_IMPORTED_METADATA_MAX_BYTES+1,key:'oversized'}));expect(await createFreshImportedMetadataRecovery(g.options).metadata(token,g.target)).toBeNull();expect(g.io.read).not.toHaveBeenCalled();
  const j=fixture();j.io.read=vi.fn(async()=>Buffer.alloc(FRESH_IMPORTED_METADATA_MAX_BYTES+1));expect(await createFreshImportedMetadataRecovery(j.options).metadata(token,j.target)).toBeNull();
 });
 it('returns independent objects so callers cannot mutate cached scalar evidence',async()=>{
  const f=fixture(),first=(await f.recovery.metadata(token,f.target))!;first.proof.observation.decimals=18;first.value.decimals=18;
  expect((await f.recovery.metadata(token,f.target))?.value.decimals).toBe(9);expect((await f.recovery.metadata(token,f.target))?.proof.observation.decimals).toBe(9);
 });
});

describe('independent retained-field agreement for typed metadata',()=>{
 const value={address:token,name:null,symbol:null,decimals:9,supplyRaw:'100000000000000000000',block:{number:100,hash:h(100),timestamp:'2026-10-23T20:00:00.000Z'}};
 const word=(n:bigint)=>'0x'+n.toString(16).padStart(64,'0'),decimals={to:token,data:'0x313ce567',result:word(9n)},supply={to:token,data:'0x18160ddd',result:word(BigInt(value.supplyRaw))};
 const source=(calls:unknown[])=>({version:1,blockNumber:100,blockHash:h(100),calls});
 it('allows absent fields and independently matching partial or complete original calls without RPC',()=>{
  for(const prior of[undefined,source([]),source([decimals]),source([supply]),source([decimals,supply])])expect(freshImportedMetadataMatchesState(value,prior)).toBe(true);
 });
 it('rejects a contradictory supply even when the original decimals call is missing',()=>{
  expect(freshImportedMetadataMatchesState(value,source([{...supply,result:word(1n)}]))).toBe(false);
 });
 it('rejects independently contradictory precision and unsupported missing scalar values',()=>{
  expect(freshImportedMetadataMatchesState(value,source([{...decimals,result:word(18n)}]))).toBe(false);
  expect(freshImportedMetadataMatchesState({...value,supplyRaw:null},source([supply]))).toBe(false);
 });
 it.each(['0x','0x12','0x'+'0'.repeat(66)])('rejects malformed present ABI scalar %s even when the other field is absent',result=>{
  expect(freshImportedMetadataMatchesState(value,source([{...supply,result}]))).toBe(false);
  expect(freshImportedMetadataMatchesState(value,source([{...decimals,result}]))).toBe(false);
 });
 it('rejects malformed, duplicated or foreign original envelopes instead of treating them as missing',()=>{
  for(const prior of[null,{...source([supply]),blockHash:h(101)},{...source([supply]),blockNumber:101},source([supply,supply]),{...source([supply]),version:2}])expect(freshImportedMetadataMatchesState(value,prior)).toBe(false);
 });
 it('ignores unrelated valid calls while preserving exact target call identity',()=>{
  expect(freshImportedMetadataMatchesState(value,source([{...supply,to:'0x'+'2'.repeat(40),result:'0x12'},{...supply,data:'0x18160ddd00',result:'0x12'}]))).toBe(true);
 });
});
