import {describe,expect,it} from 'vitest';
import type {Pool} from 'pg';
import {freshEventInScope,type FreshFinancialEvent,type FreshScope} from './accounting.js';
import {createFreshServices} from './services.js';
import type {FreshReplayManifest} from './replay.js';
import {GREEN_MORNING_HISTORY_POLICY,GREEN_MORNING_985ETH_HISTORY_POLICY,GREEN_MORNING_HISTORY_WALLETS,GREEN_MORNING_TOKEN_ADDRESS as token,greenMorningHistoryKey,readFreshGreenMorningHistoryAdmission} from './tracking.js';

const [wallet,other]=Object.keys(GREEN_MORNING_HISTORY_WALLETS) as (keyof typeof GREEN_MORNING_HISTORY_WALLETS)[];
const origin=GREEN_MORNING_HISTORY_WALLETS[wallet],startBlock=129627586,startHash='0x'+'a'.repeat(64),startTime='2026-10-25T02:42:03.000Z';
const start={block_number:String(startBlock),block_hash:startHash,value:{startBlock,startHash,startTime}};
const tokenPermission={version:1,kind:'explicit_existing',chainId:56,tokenAddress:token,active:true,startBlock,startHash,startTime,fromBlock:startBlock+1,approvedAt:'2026-11-06T00:00:00.000Z',reason:'user_approved_green_morning_only'};
const permission={version:1,policy:GREEN_MORNING_HISTORY_POLICY,active:true,wallet,token,startBlock,startHash,evidenceSha256:'c'.repeat(64)};
function fixture(selected:keyof typeof GREEN_MORNING_HISTORY_WALLETS=wallet){
  const boundary=GREEN_MORNING_HISTORY_WALLETS[selected];
  let value={...permission,wallet:selected,policy:String(permission.policy)},original=tokenPermission;
  const db={async query(sql:string){
    if(sql.startsWith('SELECT s.kind'))return {rows:[{kind:'kol',account_id:null,revision:'1',correction_epoch:'1',wallet_addresses:[selected],starts_at:startTime}]};
    if(sql.includes("key='start'"))return {rows:[start]};
    if(sql.includes('key=ANY'))return {rows:[{key:'token_admission:'+token,value:original},{key:greenMorningHistoryKey(selected),block_number:String(boundary.block),block_hash:boundary.hash,value}]};
    if(sql.includes('fresh.launch_facts'))return {rows:[]};
    return {rows:[{ok:1}],rowCount:1};
  }} as unknown as Pool;
  return {db,update:(patch:Partial<typeof value>)=>{value={...value,...patch};},revokeOriginal:()=>{original={...original,active:false};}};
}
describe('wallet-specific GREEN MORNING history',()=>{
  it('allows only the original contract and approved public wallet through its original observation floor',async()=>{
    const {db}=fixture(),history=(await readFreshGreenMorningHistoryAdmission(db,wallet))!;
    const scope:FreshScope={id:'kol:'+wallet,kind:'kol',accountId:null,walletAddresses:[wallet],startsBlock:String(startBlock),startsAt:startTime,revision:'1',tokenHistoryStarts:{[token]:history}};
    const event={walletAddress:wallet,tokenAddress:token,blockNumber:String(origin.block),occurredAt:origin.time} as FreshFinancialEvent;
    expect(freshEventInScope(scope,event)).toBe(true);
    expect(freshEventInScope(scope,{...event,tokenAddress:'0x'+'b'.repeat(40)})).toBe(false);
    expect(freshEventInScope(scope,{...event,blockNumber:String(origin.block-1)})).toBe(false);
    expect(freshEventInScope({...scope,id:'kol:'+other,walletAddresses:[other]},{...event,walletAddress:other})).toBe(false);
    expect(freshEventInScope({...scope,id:'account',kind:'portfolio_wallet',accountId:'private'},event)).toBe(false);
  });
  it('requires its own authorization before exposing the recovered 985.eth history',async()=>{
    const selected='0x61fd0d043d519f5a2bd05785000f30db96809429',f=fixture(selected);
    expect(await readFreshGreenMorningHistoryAdmission(f.db,selected)).toBeNull();
    f.update({policy:GREEN_MORNING_985ETH_HISTORY_POLICY});
    const history=await readFreshGreenMorningHistoryAdmission(f.db,selected);
    expect(history).toMatchObject({policy:GREEN_MORNING_985ETH_HISTORY_POLICY,startsBlock:'124778728'});
    expect(await readFreshGreenMorningHistoryAdmission(f.db,wallet)).toBeNull();
  });
  it('revalidates the exact history digest on a live replay lease and fails closed after revocation',async()=>{
    const f=fixture(),history=(await readFreshGreenMorningHistoryAdmission(f.db,wallet))!;
    const service=createFreshServices(f.db),claim={scopeId:'kol:'+wallet,scope:'public',wallet,token,cutoffBlock:'132000000',correctionEpoch:'1',membershipRevision:'1',from:origin.time,historyPermissionDigest:history.permissionDigest} as FreshReplayManifest;
    expect(await service.validateRevision(claim)).toBe(true);
    expect(await service.validateRevision({...claim,historyPermissionDigest:undefined})).toBe(false);
    expect(await service.validateRevision({...claim,token:'0x'+'b'.repeat(40)})).toBe(false);
    f.update({evidenceSha256:'d'.repeat(64)});
    expect(await service.validateRevision(claim)).toBe(false);
    f.revokeOriginal();
    expect(await readFreshGreenMorningHistoryAdmission(f.db,wallet)).toBeNull();
  });
});
