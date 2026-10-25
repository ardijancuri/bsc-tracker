import{describe,it,expect}from'vitest';
import{createHash}from'node:crypto';
import{decodeFreshEvidence,encodeFreshEvidence}from'./capture.js';
import{recoverFreshGangHistoricalMetadata,validFreshGangImportedMetadata,type FreshGangMetadataInput,type FreshGangImportedMetadata}from'./gangMetadata.js';
import{GANG_TOKEN_ADDRESS}from'./tracking.js';
import actual from'../fixtures/gang-metadata-witness.json'with{type:'json'};
function input(target=actual.targets[0]):FreshGangMetadataInput{
 const headers=new Map([actual.source.block,actual.runtime.block,actual.after.block,...actual.targets].map(b=>[b.number,b]));
 return{chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,target:structuredClone(target),source:{block:structuredClone(actual.source.block),payload:Buffer.from(actual.source.payloadBase64,'base64')},
  runtime:structuredClone(actual.runtime),after:structuredClone(actual.after)as any,canonicalHeader:async number=>headers.get(number)??null};
}
describe('exact GANG immutable precision and burn-only supply proof',()=>{
 it('reconstructs all six actual later missing precision blocks from original committed evidence without RPC',async()=>{
  for(const target of actual.targets){const result=await recoverFreshGangHistoricalMetadata(input(target));expect(result).not.toBeNull();
   expect(result?.metadata).toMatchObject({address:GANG_TOKEN_ADDRESS,decimals:18,supplyRaw:'999372435821745795669576335',name:null,symbol:null,block:target});
   expect(result?.proof.supply).toMatchObject({kind:'equal_bracketing_burn_only_supply'});
   expect(result?.proof.source.payloadSha256).toBe(actual.source.payloadSha256);
  }
 });
 it('never extrapolates a supply value without two actual equal bracketing observations',async()=>{
  const one=input();delete one.after;expect((await recoverFreshGangHistoricalMetadata(one))?.metadata).toMatchObject({decimals:18,supplyRaw:null});
  const changed=input();changed.after!.stateEvidence.calls.find(c=>c.data==='0x18160ddd')!.result='0x'+'0'.repeat(63)+'1';expect(await recoverFreshGangHistoricalMetadata(changed)).toBeNull();
  const absent=input();absent.after!.stateEvidence.calls=absent.after!.stateEvidence.calls.filter(c=>c.data!=='0x18160ddd');expect(await recoverFreshGangHistoricalMetadata(absent)).toBeNull();
 });
 it('rejects oldest uncovered trades and never borrows a later source backward',async()=>{
  const old=input();old.target={number:129203503,hash:'0x'+'a'.repeat(64),timestamp:'2026-10-22T10:00:00.000Z'};expect(await recoverFreshGangHistoricalMetadata(old)).toBeNull();
  const same=input();same.target={...same.source.block};expect(await recoverFreshGangHistoricalMetadata(same)).toBeNull();
 });
 it('keeps the explicit import-only metadata envelope exact-contract, source-bound and incapable of injecting supply or money',()=>{
  const entry=decodeFreshEvidence(Buffer.from(actual.source.payloadBase64,'base64')),block=actual.source.block;
  const value:FreshGangImportedMetadata={metadata:{address:GANG_TOKEN_ADDRESS,decimals:18,supplyRaw:null,name:null,symbol:null,block},proof:{version:1,kind:'gmgn_reconciled_gang_precision',chainId:56,
   tokenAddress:GANG_TOKEN_ADDRESS,datasetSha256:'a'.repeat(64),target:block,originalEvidenceHash:createHash('sha256').update(JSON.stringify([entry.transaction,entry.receipt])).digest('hex')}};
  expect(validFreshGangImportedMetadata(value,entry,block)).toBe(true);
  const before=structuredClone(entry.stateEvidence!);before.calls=before.calls.filter(c=>c.to!==GANG_TOKEN_ADDRESS);
  expect(validFreshGangImportedMetadata(value,entry,block,before)).toBe(true);
  const merged=structuredClone(before);merged.calls.push({to:GANG_TOKEN_ADDRESS,data:'0x313ce567',result:'0x'+'0'.repeat(63)+'6'});
  expect(validFreshGangImportedMetadata(value,entry,block,merged)).toBe(false);
  const mergedSupply=structuredClone(before);mergedSupply.calls.push({to:GANG_TOKEN_ADDRESS,data:'0x18160ddd',result:'0x'+'0'.repeat(63)+'1'});
  expect(validFreshGangImportedMetadata(value,entry,block,mergedSupply)).toBe(false);
  for(const mutate of[(x:FreshGangImportedMetadata)=>{x.metadata.supplyRaw='1000';},(x:FreshGangImportedMetadata)=>{x.metadata.decimals=6;},
   (x:FreshGangImportedMetadata)=>{x.proof.datasetSha256='unknown';},(x:FreshGangImportedMetadata)=>{x.proof.originalEvidenceHash='a'.repeat(64);},
   (x:FreshGangImportedMetadata)=>{x.proof.tokenAddress='0x'+'1'.repeat(40);}]){const bad=structuredClone(value);mutate(bad);expect(validFreshGangImportedMetadata(bad,entry,block)).toBe(false);}
  expect(validFreshGangImportedMetadata(value,entry,actual.targets[0])).toBe(false);
 });
 it.each(['chain','token','runtime','source_header','runtime_header','after_header','pre_haber','source_result','source_contract','corrupt_payload','after_bounds']as const)('rejects altered %s proof',async kind=>{
  const x=input();if(kind==='chain')x.chainId=1;if(kind==='token')x.tokenAddress='0x'+'1'.repeat(40);
  if(kind==='runtime')x.runtime.code=x.runtime.code.slice(0,-2)+'00';
  if(kind.endsWith('_header')){const number=kind==='source_header'?x.source.block.number:kind==='runtime_header'?x.runtime.block.number:x.after!.block.number,load=x.canonicalHeader;
   x.canonicalHeader=async n=>n===number?null:load(n);}
  if(kind==='pre_haber')x.source.block.timestamp='2024-06-19T00:00:00.000Z';
  if(kind==='source_result'||kind==='source_contract'){const entry=decodeFreshEvidence(x.source.payload),call=entry.stateEvidence!.calls.find(c=>c.data==='0x313ce567')!;
   if(kind==='source_result')call.result='0x'+'0'.repeat(63)+'6';else call.to='0x'+'1'.repeat(40);x.source.payload=encodeFreshEvidence(entry);}
  if(kind==='corrupt_payload')x.source.payload[30]^=1;
  if(kind==='after_bounds')x.after!.block={...x.source.block};
  expect(await recoverFreshGangHistoricalMetadata(x)).toBeNull();
 });
});
