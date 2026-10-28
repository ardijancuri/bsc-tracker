import {createHash} from 'node:crypto';
import {freshAddress,freshHash,freshInteger,validateFreshBlock,validateFreshReceipt,type FreshBlock,type FreshLaunchFact} from './capture.js';
import {authenticateFreshConstantCloneCreation,FRESH_CONSTANT_PRECISION_AUDITS,freshConstantCloneInitcode,freshConstantCloneRuntime,type FreshMetadataCreationContext} from './constantMetadataRecovery.js';
import {classifyFreshStockwaveCreation,FRESH_BSC_GENESIS_HASH,FRESH_STOCKWAVE_FACTORY,FRESH_STOCKWAVE_DEPLOYER,FRESH_STOCKWAVE_FACTORY_CODE_HASH,FRESH_STOCKWAVE_DEPLOYER_CODE_HASH,FRESH_STOCKWAVE_CREATION_CODE_HASH,FRESH_STOCKWAVE_LAUNCH_TOPIC} from './factoryLaunch.js';
import {FLAP_PORTAL,FOUR_MANAGERS,flapInterface,fourInterface,fourV1Interface} from '../launchpad.js';
import {keccak256} from 'ethers';

const stable=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const sha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
const integer=(v:unknown)=>{const n=Number(freshInteger(v));if(!Number.isSafeInteger(n)||n<0)throw Error('token_birth_integer');return n;};
const header=(b:FreshBlock)=>({number:integer(b.number),hash:b.hash.toLowerCase(),parentHash:b.parentHash.toLowerCase(),timestamp:new Date(integer(b.timestamp)*1000).toISOString()});
const identity=(f:FreshLaunchFact)=>[f.tokenAddress,f.protocol,f.blockNumber,f.blockHash,f.txHash,f.logIndex,f.launchedAt,f.status];
export interface FreshKnownTokenBirthCertificate {
 version:1;kind:'authenticated_protocol_token_birth_v1';chainId:56;tokenAddress:string;protocol:FreshLaunchFact['protocol'];
 start:{number:number;hash:string};birth:ReturnType<typeof header>;transactionHash:string;transactionIndex:number;logIndex:number|null;
 originalContextSha256:string;factIdentitySha256:string;authentication:Record<string,unknown>;
}
/** This is an ingestion/operator verifier, never a request-time RPC scanner.
 * A pool or an arbitrary launch event is insufficient. The complete canonical
 * transaction/receipt must replay an existing exact creation authenticator. */
export function certifyFreshKnownTokenBirth(input:{fact:FreshLaunchFact;creation:FreshMetadataCreationContext;start:{number:number;hash:string}}):FreshKnownTokenBirthCertificate|null{
 try{
  const {fact,creation:c,start}=input;if(fact.status!=='eligible'||!freshAddress(fact.tokenAddress)||!freshHash(start.hash)||!Number.isSafeInteger(start.number)||start.number<0)return null;
  validateFreshBlock(c.block,integer(c.block.number));validateFreshReceipt(c.receipt,c.transaction,c.block);const b=header(c.block),index=integer(c.transaction.transactionIndex);
  if(b.number<=start.number||fact.blockNumber!==b.number||fact.blockHash!==b.hash||fact.txHash!==c.transaction.hash||fact.launchedAt!==b.timestamp||c.receipt.status!=='0x1'
   ||c.transaction.chainId!==undefined&&freshInteger(c.transaction.chainId)!==56n||stable(c.block.transactions[index])!==stable(c.transaction))return null;
  let authentication:Record<string,unknown>|null=null;
  if(fact.protocol==='evm_creation'&&fact.logIndex===null&&fact.proof.creation==='top_level'&&c.transaction.to===null&&c.receipt.contractAddress?.toLowerCase()===fact.tokenAddress
   &&fact.proof.creator===c.transaction.from.toLowerCase())authentication={kind:'top_level_receipt_creation',creator:c.transaction.from.toLowerCase()};
  if(fact.protocol==='flap'||fact.protocol==='fourmeme'){
   const candidates=Object.entries(FRESH_CONSTANT_PRECISION_AUDITS).filter(([,a])=>a.protocol===fact.protocol);
   const matches=candidates.flatMap(([protocol,a])=>{const proof=authenticateFreshConstantCloneCreation(protocol as keyof typeof FRESH_CONSTANT_PRECISION_AUDITS,fact.tokenAddress,c);return proof?[{auditId:a.id,creation:proof}]:[];});
   if(matches.length!==1)return null;const match=matches[0],proof=match.creation;
   const launch=c.receipt.logs.find(l=>integer(l.logIndex)===fact.logIndex);
   if(!launch||integer(proof.creationLogIndex)!==fact.logIndex||fact.proof.controller!==proof.controller||fact.proof.topic!==launch.topics[0])return null;
   authentication={kind:'fixed_clone_create2',auditId:match.auditId,...proof};
  }
  if(fact.protocol==='stockwave'){
   const replay=classifyFreshStockwaveCreation({...c,startBlock:start.number,codeEvidence:fact.proof.codeEvidence as any});
   const original={...fact.proof};delete original.tokenBirth;
   if(!replay||stable(identity(replay))!==stable(identity(fact))||stable(replay.proof)!==stable(original))return null;
   authentication={kind:'pinned_stockwave_create2',controller:FRESH_STOCKWAVE_FACTORY,deployer:FRESH_STOCKWAVE_DEPLOYER,topic:FRESH_STOCKWAVE_LAUNCH_TOPIC,
    genesisHash:FRESH_BSC_GENESIS_HASH,factoryRuntimeHash:FRESH_STOCKWAVE_FACTORY_CODE_HASH,deployerRuntimeHash:FRESH_STOCKWAVE_DEPLOYER_CODE_HASH,tokenCreationCodeHash:FRESH_STOCKWAVE_CREATION_CODE_HASH};
  }
  if(!authentication)return null;
  return{version:1,kind:'authenticated_protocol_token_birth_v1',chainId:56,tokenAddress:fact.tokenAddress,protocol:fact.protocol,start:{...start},birth:b,
   transactionHash:fact.txHash,transactionIndex:index,logIndex:fact.logIndex,originalContextSha256:sha([c.transaction,c.receipt]),factIdentitySha256:sha(identity(fact)),authentication};
 }catch{return null;}
}
/** Additive only. Repeated certification is idempotent; conflicting evidence
 * is rejected instead of replacing the original proof or receipt. */
export function enrichFreshKnownTokenBirth(fact:FreshLaunchFact,creation:FreshMetadataCreationContext,start:{number:number;hash:string}):FreshLaunchFact{
 const certificate=certifyFreshKnownTokenBirth({fact,creation,start});if(!certificate)return fact;
 if(fact.proof.tokenBirth&&stable(fact.proof.tokenBirth)!==stable(certificate))throw Error('token_birth_certificate_conflict');
 return{...fact,proof:{...fact.proof,tokenBirth:certificate}};
}

const sqlLiteral=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const ident=(s:string)=>{if(!/^[a-z_][a-z0-9_]*$/i.test(s))throw Error('token_birth_sql_alias');return s;};
/** Readers use only a previously certified, start-bound original context.
 * This does not make raw Flap/FourMeme/pool timestamps an existence bound. */
export function freshKnownProtocolTokenBirthSql(factAlias='token_birth',bornAlias='born',startAlias='token_start'){
 const f=ident(factAlias),b=ident(bornAlias),s=ident(startAlias),p=`${f}.proof->'tokenBirth'`,a=`${p}->'authentication'`;
 const clones=Object.entries(FRESH_CONSTANT_PRECISION_AUDITS).map(([protocol,audit])=>`(${f}.protocol=${sqlLiteral(audit.protocol)} AND ${a}->>'auditId'=${sqlLiteral(audit.id)}
  AND ${a}->>'protocol'=${sqlLiteral(protocol)} AND ${a}->>'deployer'=${sqlLiteral(audit.deployer)} AND ${a}->>'implementationAddress'=${sqlLiteral(audit.implementation)}
  AND ${a}->>'initcodeHash'=${sqlLiteral(keccak256(freshConstantCloneInitcode(protocol as keyof typeof FRESH_CONSTANT_PRECISION_AUDITS)))}
  AND ${a}->>'runtimeHash'=${sqlLiteral(keccak256(freshConstantCloneRuntime(protocol as keyof typeof FRESH_CONSTANT_PRECISION_AUDITS)))}
  AND ${a}->>'controller'=${f}.proof->>'controller' AND ${a}->>'salt'~'^0x[0-9a-f]{64}$'
  AND ${a}->>'tokenAddress'=${f}.token_address AND ${a}->>'transactionHash'=${f}.tx_hash
  AND ${a}->'block'=jsonb_build_object('number',${b}.block_number,'hash',${b}.block_hash,'timestamp',to_char(${b}.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  AND ${f}.proof->>'controller'${audit.protocol==='flap'?`=${sqlLiteral(FLAP_PORTAL)}`:` IN(${FOUR_MANAGERS.map(sqlLiteral).join(',')})`}
  AND ${f}.proof->>'topic' IN(${(audit.protocol==='flap'?[flapInterface]:[fourInterface,fourV1Interface]).map(abi=>sqlLiteral(abi.getEvent(audit.protocol==='flap'?'TokenCreated':'TokenCreate')!.topicHash)).join(',')}))`).join(' OR ');
 return`(${p}->'version'='1'::jsonb AND ${p}->>'kind'='authenticated_protocol_token_birth_v1' AND ${p}->'chainId'='56'::jsonb
  AND ${p}->>'tokenAddress'=${f}.token_address AND ${p}->>'protocol'=${f}.protocol
  AND ${p}->'start'=jsonb_build_object('number',${s}.block_number,'hash',${s}.block_hash)
  AND ${p}->'birth'=jsonb_build_object('number',${b}.block_number,'hash',${b}.block_hash,'parentHash',${b}.parent_hash,'timestamp',to_char(${b}.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  AND ${p}->>'transactionHash'=${f}.tx_hash AND ${p}->'logIndex'=COALESCE(to_jsonb(${f}.log_index),'null'::jsonb)
  AND ${p}->>'originalContextSha256'~'^[0-9a-f]{64}$' AND ${p}->>'factIdentitySha256'~'^[0-9a-f]{64}$'
  AND(${f}.protocol='evm_creation' AND ${f}.log_index IS NULL AND ${f}.proof->>'creation'='top_level' AND ${a}->>'kind'='top_level_receipt_creation'
    AND ${a}->>'creator'=${f}.proof->>'creator' AND ${a}->>'creator'~'^0x[0-9a-f]{40}$'
   OR ${a}->>'kind'='fixed_clone_create2' AND ${f}.log_index IS NOT NULL AND(${clones})
   OR ${f}.protocol='stockwave' AND ${f}.log_index IS NOT NULL AND ${a}->>'kind'='pinned_stockwave_create2'
    AND ${f}.proof->'version'='1'::jsonb AND ${f}.proof->>'classification'='authenticated_factory_create2'
    AND ${f}.proof->>'historicalCodeBasis'='bsc_bep344_persistent_runtime_inference'
    AND ${f}.proof->>'controller'=${sqlLiteral(FRESH_STOCKWAVE_FACTORY)} AND ${f}.proof->>'deployer'=${sqlLiteral(FRESH_STOCKWAVE_DEPLOYER)}
    AND ${f}.proof->>'topic'=${sqlLiteral(FRESH_STOCKWAVE_LAUNCH_TOPIC)}
    AND ${f}.proof->'codeEvidence'->'version'='1'::jsonb AND ${f}.proof->'codeEvidence'->'chainId'='56'::jsonb
    AND ${f}.proof->'codeEvidence'->>'genesisHash'=${sqlLiteral(FRESH_BSC_GENESIS_HASH)}
    AND ${f}.proof->'codeEvidence'->>'factoryRuntimeHash'=${sqlLiteral(FRESH_STOCKWAVE_FACTORY_CODE_HASH)}
    AND ${f}.proof->'codeEvidence'->>'deployerRuntimeHash'=${sqlLiteral(FRESH_STOCKWAVE_DEPLOYER_CODE_HASH)}
    AND ${f}.proof->'codeEvidence'->>'tokenCreationCodeHash'=${sqlLiteral(FRESH_STOCKWAVE_CREATION_CODE_HASH)}
    AND ${f}.proof->'codeEvidence'->>'immutabilityRule'='bsc_bep344_eip6780'
    AND ${a}->>'controller'=${sqlLiteral(FRESH_STOCKWAVE_FACTORY)} AND ${a}->>'deployer'=${sqlLiteral(FRESH_STOCKWAVE_DEPLOYER)}
    AND ${a}->>'topic'=${sqlLiteral(FRESH_STOCKWAVE_LAUNCH_TOPIC)} AND ${a}->>'genesisHash'=${sqlLiteral(FRESH_BSC_GENESIS_HASH)}
    AND ${a}->>'factoryRuntimeHash'=${sqlLiteral(FRESH_STOCKWAVE_FACTORY_CODE_HASH)} AND ${a}->>'deployerRuntimeHash'=${sqlLiteral(FRESH_STOCKWAVE_DEPLOYER_CODE_HASH)}
    AND ${a}->>'tokenCreationCodeHash'=${sqlLiteral(FRESH_STOCKWAVE_CREATION_CODE_HASH)}))`;
}
