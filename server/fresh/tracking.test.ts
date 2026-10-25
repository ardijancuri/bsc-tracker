import {describe,expect,it} from 'vitest';
import {GANG_TOKEN_ADDRESS,freshTokenAdmissionKey,freshTokenAdmissionDigest,validFreshExistingTokenPermission,readFreshTokenAdmission,
 freshTrackedTokenSql,freshTrackedEventSql,freshExistingTokenAdmissionSql,type FreshExistingTokenPermission,type FreshTrackingStart} from './tracking.js';
const start:FreshTrackingStart={block_number:'100',block_hash:'0x'+'a'.repeat(64),value:{startBlock:100,startHash:'0x'+'a'.repeat(64),startTime:'2026-10-25T02:42:03.000Z'}};
const approved=():FreshExistingTokenPermission=>({version:1,kind:'explicit_existing',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,
 startBlock:100,startHash:start.block_hash,startTime:String(start.value.startTime),fromBlock:101,approvedAt:'2026-10-25T12:00:00.000Z',reason:'user_approved_gang_only'});
function fixture(options:{start?:FreshTrackingStart|null;fact?:Record<string,unknown>;permission?:unknown}={}){
 const queries:{sql:string;values?:unknown[]}[]=[];const db={async query(sql:string,values?:unknown[]){queries.push({sql,values});
  if(sql.includes("key='start'"))return{rows:options.start===null?[]:[options.start??start]};
  if(sql.includes('fresh.launch_facts'))return{rows:options.fact?[options.fact]:[]};
  if(sql.includes('WHERE key=$1'))return{rows:options.permission===undefined?[]:[{value:options.permission}]};
  throw Error('unexpected_tracking_query');}};
 return{db:db as any,queries};
}
describe('one explicit preexisting GANG tracking permission',()=>{
 it('binds a typed permission to the original start without claiming a launch',()=>{
  expect(validFreshExistingTokenPermission(approved(),start)).toBe(true);expect(freshTokenAdmissionKey(GANG_TOKEN_ADDRESS)).toBe('token_admission:'+GANG_TOKEN_ADDRESS);
 });
 it.each([
  ['tokenAddress','0x'+'b'.repeat(40)],['kind','new_launch'],['chainId',1],['active',false],['version','1'],['startBlock','100'],
  ['startHash','0x'+'b'.repeat(64)],['startTime','2026-10-25T02:42:04.000Z'],['fromBlock',100],['reason','arbitrary'],
  ['approvedAt','2026-02-30T12:00:00.000Z'],['approvedAt','2026-10-25T24:00:00.000Z'],['approvedAt','today'],
 ])('rejects changed or malformed %s',(key,value)=>{expect(validFreshExistingTokenPermission({...approved(),[key]:value},start)).toBe(false);});
 it('rejects missing/extra keys, arrays and changed collection boundaries',()=>{
  const p:any=approved();delete p.approvedAt;expect(validFreshExistingTokenPermission(p,start)).toBe(false);
  expect(validFreshExistingTokenPermission({...approved(),extra:true},start)).toBe(false);expect(validFreshExistingTokenPermission([],start)).toBe(false);
  expect(validFreshExistingTokenPermission(approved(),{...start,value:{...start.value,startBlock:99}})).toBe(false);
 });
 it('uses a stable permission digest independent of JSON property order',()=>{
  const a=approved(),b=Object.fromEntries(Object.entries(a).reverse()) as unknown as FreshExistingTokenPermission;
  expect(freshTokenAdmissionDigest(a)).toBe(freshTokenAdmissionDigest(b));expect(freshTokenAdmissionDigest({...a,approvedAt:'2026-10-25T12:01:00.000Z'})).not.toBe(freshTokenAdmissionDigest(a));
 });
 it('admits GANG only after the unchanged start, with no synthetic launch fact',async()=>{
  const f=fixture({permission:approved()}),result=await readFreshTokenAdmission(f.db,GANG_TOKEN_ADDRESS,{blockNumber:101});
  expect(result).toMatchObject({kind:'preexisting',launchStatus:'preexisting',fromBlock:101,permission:approved()});expect(result).not.toHaveProperty('fact');
  expect(f.queries).toHaveLength(4);expect(f.queries.every(q=>!/(INSERT|UPDATE|DELETE|CREATE)\s/i.test(q.sql))).toBe(true);
 });
 it('does not admit a different token or revoked permission',async()=>{
  expect(await readFreshTokenAdmission(fixture({permission:approved()}).db,'0x'+'b'.repeat(40),{blockNumber:101})).toBeNull();
  expect(await readFreshTokenAdmission(fixture({permission:{...approved(),active:false}}).db,GANG_TOKEN_ADDRESS)).toBeNull();
 });
 it('locks start, authentic fact and permission before a financial commit',async()=>{
  const f=fixture({permission:approved()});expect(await readFreshTokenAdmission(f.db,GANG_TOKEN_ADDRESS,{blockNumber:150,lock:true})).not.toBeNull();
  expect(f.queries.every(q=>q.sql.endsWith(' FOR SHARE'))).toBe(true);
 });
 it('cannot override an authenticated non-token exclusion',async()=>{
  const f=fixture({fact:{status:'excluded_non_token',block_number:'90'},permission:approved()});
  expect(await readFreshTokenAdmission(f.db,GANG_TOKEN_ADDRESS,{blockNumber:150})).toBeNull();expect(f.queries).toHaveLength(2);
 });
 it('preserves ordinary post-boundary launch behavior',async()=>{
  const fact={token_address:'0x'+'b'.repeat(40),status:'eligible',block_number:'110'};
  expect(await readFreshTokenAdmission(fixture({fact}).db,String(fact.token_address),{blockNumber:110})).toEqual({kind:'new_launch',fact,fromBlock:101,launchStatus:'eligible'});
  expect(await readFreshTokenAdmission(fixture({fact}).db,String(fact.token_address),{blockNumber:109})).toBeNull();
  expect(await readFreshTokenAdmission(fixture({fact:{...fact,block_number:'99'}}).db,String(fact.token_address))).toBeNull();
 });
 it('refuses a missing boundary, a pre-boundary target or an invalid address',async()=>{
  expect(await readFreshTokenAdmission(fixture({start:null,permission:approved()}).db,GANG_TOKEN_ADDRESS)).toBeNull();
  expect(await readFreshTokenAdmission(fixture({permission:approved()}).db,GANG_TOKEN_ADDRESS,{blockNumber:100})).toBeNull();
  expect(await readFreshTokenAdmission(fixture().db,'bad-address')).toBeNull();
 });
 it('SQL requires exact typed GANG permission, boundary, genuine event floor and no exclusion',()=>{
  const sql=freshTrackedEventSql('event','token');expect(sql).toContain("token.launch_status='preexisting'");expect(sql).toContain(GANG_TOKEN_ADDRESS);
  expect(sql).toContain("'chainId',56");expect(sql).toContain("'fromBlock',tracking_start.block_number+1");expect(sql).toContain('excluded_non_token');
  expect(sql).toContain('event.block_number>=event_start.block_number+1');expect(sql).toContain('event.occurred_at>=');
  expect(freshTrackedTokenSql()).toContain("t.launch_status='eligible'");expect(freshExistingTokenAdmissionSql('$1')).toContain('$1');
 });
 it('rejects SQL identifiers and address expressions that could contain arbitrary SQL',()=>{
  for(const bad of ['x;DELETE','x.address OR true','*','token_admission:'])expect(()=>freshTrackedTokenSql(bad)).toThrow();
  for(const bad of ['x;DELETE','$1 OR true',"'0x1'",'x.address;'])expect(()=>freshExistingTokenAdmissionSql(bad)).toThrow();
 });
});
