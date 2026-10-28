import{describe,it,expect}from'vitest';
import{certifyFreshKnownTokenBirth,enrichFreshKnownTokenBirth,freshKnownProtocolTokenBirthSql}from'./tokenBirth.js';
import{tokenBirthFixture,topLevelBirthFixture,stockwaveBirthFixture,birthAddress,birthHash}from'./fixtures/tokenBirthFixture.js';
describe('authenticated protocol token birth',()=>{
 for(const p of['flap','fourmeme','fourmemeffff']as const)it(`certifies ${p} from exact original creation and preserves original fact fields`,()=>{
  const x=tokenBirthFixture(p),before=structuredClone(x.fact),certificate=certifyFreshKnownTokenBirth(x),enriched=enrichFreshKnownTokenBirth(x.fact,x.creation,x.start);
  expect(certificate).toMatchObject({kind:'authenticated_protocol_token_birth_v1',tokenAddress:x.token,protocol:x.fact.protocol,start:x.start,birth:{number:120,hash:birthHash(120)},authentication:{kind:'fixed_clone_create2'}});
  expect(x.fact).toEqual(before);expect(enriched).toEqual({...before,proof:{...before.proof,tokenBirth:certificate}});expect(enrichFreshKnownTokenBirth(enriched,x.creation,x.start)).toEqual(enriched);
 });
 it('certifies actual top-level receipt creation without confusing a token transfer with creation',()=>{const x=topLevelBirthFixture();expect(certifyFreshKnownTokenBirth(x)?.authentication).toEqual({kind:'top_level_receipt_creation',creator:x.creation.transaction.from});x.creation.transaction.to=birthAddress(10);expect(certifyFreshKnownTokenBirth(x)).toBeNull();});
 it('replays only the exact existing Stockwave factory/code/constructor authenticator',()=>{const x=stockwaveBirthFixture();expect(certifyFreshKnownTokenBirth(x)?.authentication.kind).toBe('pinned_stockwave_create2');x.fact.proof.codeEvidence={};expect(certifyFreshKnownTokenBirth(x)).toBeNull();});
 const mutations:[string,(x:ReturnType<typeof tokenBirthFixture>)=>void][]=[
  ['unknown factory',x=>{x.creation.receipt.logs.at(-1)!.address=birthAddress(5);}],['missing mint',x=>{x.creation.receipt.logs=x.creation.receipt.logs.slice(1);}],
  ['different salt',x=>{x.creation.receipt.logs[1].data=x.creation.receipt.logs[1].data.replace(birthHash(120).slice(2),birthHash(121).slice(2));}],
  ['failed transaction',x=>{x.creation.receipt.status='0x0';}],['missing canonical member',x=>{x.creation.block.transactions=[];}],['wrong canonical member',x=>{x.creation.block.transactions=[{...x.creation.transaction,value:'0x1'}];}],
  ['wrong chain',x=>{x.creation.transaction.chainId='0x1';}],['before boundary',x=>{x.start.number=120;}],['excluded token',x=>{x.fact.status='excluded_non_token';}],['foreign token',x=>{x.fact.tokenAddress=birthAddress(5);}],
  ['changed block',x=>{x.fact.blockHash=birthHash(123);}],['changed transaction',x=>{x.fact.txHash=birthHash(2);}],['changed time',x=>{x.fact.launchedAt=new Date(0).toISOString();}],['wrong log index',x=>{x.fact.logIndex=0;}],
  ['raw pool event',x=>{x.fact.protocol='stockwave';}],['wrong row controller',x=>{x.fact.proof.controller=birthAddress(1);}],['wrong row topic',x=>{x.fact.proof.topic=birthHash(1);}]
 ];
 it.each(mutations)('rejects %s rather than approving a generic launch timestamp',(_name,mutate)=>{const x=tokenBirthFixture();mutate(x);expect(certifyFreshKnownTokenBirth(x)).toBeNull();expect(enrichFreshKnownTokenBirth(x.fact,x.creation,x.start)).toBe(x.fact);});
 it('rejects contradictory prior certification without overwriting original proof',()=>{const x=tokenBirthFixture(),f={...x.fact,proof:{...x.fact.proof,tokenBirth:{kind:'unverified'}}};expect(()=>enrichFreshKnownTokenBirth(f,x.creation,x.start)).toThrow('token_birth_certificate_conflict');});
 it('builds only start/row/physical-block and exact audited protocol certificate checks',()=>{const sql=freshKnownProtocolTokenBirthSql();expect(sql).toContain('authenticated_protocol_token_birth_v1');expect(sql).toContain("'chainId'='56'::jsonb");expect(sql).toContain('runtimeHash');expect(sql).toContain('fixed_clone_create2');expect(sql).not.toContain('pair_created');expect(()=>freshKnownProtocolTokenBirthSql('unsafe;')).toThrow('token_birth_sql_alias');});
});
