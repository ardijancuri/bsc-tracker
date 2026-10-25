import {createHash} from 'node:crypto';
import type {Pool} from 'pg';

/** Explicit user-approved exception. This permission is not evidence of a new
 * deployment, a purchase cost, token precision or a historical market price. */
export const GANG_TOKEN_ADDRESS='0x0c6302401aa5325c2e36f170f52c00b1d220b405';
export const FRESH_GANG_HISTORY_FROM_BLOCK=128977030,FRESH_GANG_CREATION_HASH='0x5f21700cb2dd516df53c00b30dff0e0fa15d80ac3097f020591cd4b4a599ed46',FRESH_GANG_CREATION_TIME='2026-10-21T17:20:53.000Z';
export const FRESH_GANG_HISTORY_ADMISSION_KEY='token_history_admission:'+GANG_TOKEN_ADDRESS;
export const freshTokenAdmissionKey=(address:string)=>'token_admission:'+address.toLowerCase();
/** The predecessor hash is the authenticated creation block, not an invented
 * launch at Kollens' collection boundary. This exception is public-GANG only. */
export interface FreshGangHistoryPermission{version:1;kind:'explicit_token_history';chainId:56;tokenAddress:typeof GANG_TOKEN_ADDRESS;active:true;
 startBlock:number;startHash:string;startTime:string;historyFromBlock:typeof FRESH_GANG_HISTORY_FROM_BLOCK;historyFromHash:typeof FRESH_GANG_CREATION_HASH;
 historyFromTime:typeof FRESH_GANG_CREATION_TIME;sourceDatasetSha256:string;approvedAt:string;policy:'gmgn_gang_only_history_v1'}
export interface FreshExistingTokenPermission {
 version:1;kind:'explicit_existing';chainId:56;tokenAddress:typeof GANG_TOKEN_ADDRESS;active:true;
 startBlock:number;startHash:string;startTime:string;fromBlock:number;approvedAt:string;reason:'user_approved_gang_only';
}
export type FreshTokenAdmission=
 |{kind:'new_launch';fact:Record<string,any>;fromBlock:number;launchStatus:'eligible'}
 |{kind:'preexisting';permission:FreshExistingTokenPermission;history?:FreshGangHistoryPermission;admissionDigest:string;fromBlock:number;launchStatus:'preexisting'};
export interface FreshTrackingStart {block_number:string|number;block_hash:string;value:{startBlock?:unknown;startHash?:unknown;startTime?:unknown}}
const hash=/^0x[0-9a-f]{64}$/,address=/^0x[0-9a-f]{40}$/;
const iso=(value:unknown)=>typeof value==='string'&&/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const fields=['version','kind','chainId','tokenAddress','active','startBlock','startHash','startTime','fromBlock','approvedAt','reason'];
export function validFreshExistingTokenPermission(value:unknown,start:FreshTrackingStart):value is FreshExistingTokenPermission {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const p=value as Record<string,unknown>,n=Number(start.block_number);
 return Object.keys(p).length===fields.length&&fields.every(k=>Object.hasOwn(p,k))
  &&p.version===1&&p.kind==='explicit_existing'&&p.chainId===56&&p.tokenAddress===GANG_TOKEN_ADDRESS&&p.active===true&&p.reason==='user_approved_gang_only'
  &&Number.isSafeInteger(n)&&n>0&&n<Number.MAX_SAFE_INTEGER&&Number.isSafeInteger(p.startBlock)&&p.startBlock===n
  &&typeof start.block_hash==='string'&&hash.test(start.block_hash)&&p.startHash===start.block_hash
  &&start.value?.startBlock===n&&start.value.startHash===start.block_hash&&iso(start.value.startTime)&&p.startTime===start.value.startTime
  &&p.fromBlock===n+1&&iso(p.approvedAt);
}
export function freshTokenAdmissionDigest(permission:FreshExistingTokenPermission){
 return createHash('sha256').update(JSON.stringify(fields.map(k=>[k,permission[k as keyof FreshExistingTokenPermission]]))).digest('hex');
}
const historyFields=['version','kind','chainId','tokenAddress','active','startBlock','startHash','startTime','historyFromBlock','historyFromHash','historyFromTime','sourceDatasetSha256','approvedAt','policy'];
export function validFreshGangHistoryPermission(value:unknown,start:FreshTrackingStart):value is FreshGangHistoryPermission{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const p=value as Record<string,unknown>,n=Number(start.block_number);
 return Object.keys(p).length===historyFields.length&&historyFields.every(k=>Object.hasOwn(p,k))&&p.version===1&&p.kind==='explicit_token_history'&&p.chainId===56
  &&p.tokenAddress===GANG_TOKEN_ADDRESS&&p.active===true&&p.policy==='gmgn_gang_only_history_v1'&&Number.isSafeInteger(n)&&n>=FRESH_GANG_HISTORY_FROM_BLOCK
  &&p.startBlock===n&&hash.test(start.block_hash)&&p.startHash===start.block_hash&&start.value?.startBlock===n&&start.value.startHash===start.block_hash
  &&iso(start.value.startTime)&&p.startTime===start.value.startTime&&p.historyFromBlock===FRESH_GANG_HISTORY_FROM_BLOCK&&p.historyFromHash===FRESH_GANG_CREATION_HASH
  &&p.historyFromTime===FRESH_GANG_CREATION_TIME&&typeof p.sourceDatasetSha256==='string'&&/^[0-9a-f]{64}$/.test(p.sourceDatasetSha256)
  &&iso(p.approvedAt)&&Date.parse(String(p.approvedAt))>=Date.parse(String(start.value.startTime))&&Date.parse(String(start.value.startTime))>=Date.parse(FRESH_GANG_CREATION_TIME);
}
export const freshGangHistoryPermissionDigest=(p:FreshGangHistoryPermission)=>createHash('sha256').update(JSON.stringify(historyFields.map(k=>[k,p[k as keyof FreshGangHistoryPermission]]))).digest('hex');
export async function readFreshGangHistoryAdmission(db:Pick<Pool,'query'>,options:{lock?:boolean}={}){
 const lock=options.lock?' FOR SHARE':'',start=(await db.query(`SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start'${lock}`)).rows[0] as FreshTrackingStart|undefined;
 if(!start)return null;const rows=(await db.query(`SELECT key,value FROM fresh.checkpoints WHERE key=ANY($1::text[]) ORDER BY key${lock}`,[[freshTokenAdmissionKey(GANG_TOKEN_ADDRESS),FRESH_GANG_HISTORY_ADMISSION_KEY]])).rows;
 const permission=rows.find(r=>r.key===freshTokenAdmissionKey(GANG_TOKEN_ADDRESS))?.value,history=rows.find(r=>r.key===FRESH_GANG_HISTORY_ADMISSION_KEY)?.value;
 if(!validFreshExistingTokenPermission(permission,start)||!validFreshGangHistoryPermission(history,start))return null;
 if((await db.query(`SELECT 1 FROM fresh.launch_facts WHERE token_address=$1 AND status='excluded_non_token'${lock}`,[GANG_TOKEN_ADDRESS])).rows.length)return null;
 return{permission:history,digest:freshGangHistoryPermissionDigest(history)};
}
export async function readFreshTokenAdmission(db:Pick<Pool,'query'>,token:string,options:{blockNumber?:number;lock?:boolean}={}):Promise<FreshTokenAdmission|null>{
 token=token.toLowerCase();if(!address.test(token))return null;
 if(options.blockNumber!==undefined&&(!Number.isSafeInteger(options.blockNumber)||options.blockNumber<1))return null;
 const lock=options.lock?' FOR SHARE':'',start=(await db.query(`SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start'${lock}`)).rows[0] as FreshTrackingStart|undefined;
 const n=Number(start?.block_number);if(!start||!Number.isSafeInteger(n)||n<1||token!==GANG_TOKEN_ADDRESS&&options.blockNumber!==undefined&&options.blockNumber<=n)return null;
 const fact=(await db.query(`SELECT * FROM fresh.launch_facts WHERE token_address=$1${lock}`,[token])).rows[0];
 if(fact?.status==='excluded_non_token')return null;
 if(fact?.status==='eligible'&&Number.isSafeInteger(Number(fact.block_number))&&Number(fact.block_number)>n
  &&(options.blockNumber===undefined||Number(fact.block_number)<=options.blockNumber))return{kind:'new_launch',fact,fromBlock:n+1,launchStatus:'eligible'};
 if(token!==GANG_TOKEN_ADDRESS)return null;
 const p=(await db.query(`SELECT value FROM fresh.checkpoints WHERE key=$1${lock}`,[freshTokenAdmissionKey(token)])).rows[0]?.value;
 if(!validFreshExistingTokenPermission(p,start))return null;
 const historical=(await db.query(`SELECT value FROM fresh.checkpoints WHERE key=$1${lock}`,[FRESH_GANG_HISTORY_ADMISSION_KEY])).rows[0]?.value,history=validFreshGangHistoryPermission(historical,start)?historical:undefined;
 const fromBlock=history?.historyFromBlock??p.fromBlock;if(options.blockNumber!==undefined&&options.blockNumber<fromBlock)return null;
 return{kind:'preexisting',permission:p,...(history?{history}:{}),admissionDigest:history?createHash('sha256').update(freshTokenAdmissionDigest(p)+freshGangHistoryPermissionDigest(history)).digest('hex'):freshTokenAdmissionDigest(p),fromBlock,launchStatus:'preexisting'};
}
const identifier=(value:string)=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw Error('tracking_sql_identifier_invalid');return value;};
const expression=(value:string)=>{if(!/^(?:[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*|\$[1-9][0-9]*)$/i.test(value))throw Error('tracking_sql_expression_invalid');return value;};
const sqlIso=(x:string)=>`(${x} ~ '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' AND CASE WHEN pg_input_is_valid(${x},'timestamptz')
 THEN to_char((${x})::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=${x} ELSE false END)`;
/** Keep SQL readers as strict as the writer: exact contract, typed permission,
 * unchanged collection boundary and no authenticated non-token exclusion. */
export function freshExistingTokenAdmissionSql(addressExpression:string){
 const x=expression(addressExpression);
 return`(${x}='${GANG_TOKEN_ADDRESS}' AND EXISTS(SELECT 1 FROM fresh.checkpoints admitted JOIN fresh.checkpoints tracking_start ON tracking_start.key='start'
 WHERE admitted.key='token_admission:'||${x} AND jsonb_typeof(admitted.value)='object'
 AND admitted.value @> jsonb_build_object('version',1,'kind','explicit_existing','chainId',56,'tokenAddress','${GANG_TOKEN_ADDRESS}','active',true,'reason','user_approved_gang_only',
 'startBlock',tracking_start.block_number,'startHash',tracking_start.block_hash,'startTime',tracking_start.value->>'startTime','fromBlock',tracking_start.block_number+1)
 AND tracking_start.value @> jsonb_build_object('startBlock',tracking_start.block_number,'startHash',tracking_start.block_hash)
 AND tracking_start.block_number>0 AND tracking_start.block_number<9007199254740991 AND tracking_start.block_hash ~ '^0x[0-9a-f]{64}$'
 AND ${sqlIso("(tracking_start.value->>'startTime')")}
 AND jsonb_typeof(admitted.value->'approvedAt')='string' AND ${sqlIso("(admitted.value->>'approvedAt')")}
 AND(SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(admitted.value)='object' THEN admitted.value ELSE '{}'::jsonb END))=11)
 AND NOT EXISTS(SELECT 1 FROM fresh.launch_facts excluded WHERE excluded.token_address=${x} AND excluded.status='excluded_non_token'))`;
}
export function freshGangHistoryAdmissionSql(tokenExpression:string){
 const x=expression(tokenExpression);return`(${freshExistingTokenAdmissionSql(x)} AND EXISTS(SELECT 1 FROM fresh.checkpoints history_admitted JOIN fresh.checkpoints history_start ON history_start.key='start'
 WHERE history_admitted.key='${FRESH_GANG_HISTORY_ADMISSION_KEY}' AND jsonb_typeof(history_admitted.value)='object'
 AND history_admitted.value @> jsonb_build_object('version',1,'kind','explicit_token_history','chainId',56,'tokenAddress','${GANG_TOKEN_ADDRESS}','active',true,'policy','gmgn_gang_only_history_v1',
 'startBlock',history_start.block_number,'startHash',history_start.block_hash,'startTime',history_start.value->>'startTime','historyFromBlock',${FRESH_GANG_HISTORY_FROM_BLOCK},'historyFromHash','${FRESH_GANG_CREATION_HASH}','historyFromTime','${FRESH_GANG_CREATION_TIME}')
 AND history_start.block_number>=${FRESH_GANG_HISTORY_FROM_BLOCK} AND (history_start.value->>'startTime')>='${FRESH_GANG_CREATION_TIME}'
 AND jsonb_typeof(history_admitted.value->'sourceDatasetSha256')='string' AND history_admitted.value->>'sourceDatasetSha256' ~ '^[0-9a-f]{64}$'
 AND jsonb_typeof(history_admitted.value->'approvedAt')='string' AND ${sqlIso("(history_admitted.value->>'approvedAt')")}
 AND (history_admitted.value->>'approvedAt')>=(history_start.value->>'startTime')
 AND(SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(history_admitted.value)='object' THEN history_admitted.value ELSE '{}'::jsonb END))=14))`;
}
const boundaryExpression=(value:string)=>{if(!/^(?:[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*|\$[1-9][0-9]*|[0-9]+)$/i.test(value))throw Error('tracking_sql_boundary_invalid');return value;};
export function freshGangHistoryScopeSql(scopeAlias:string,tokenExpression:string){const s=identifier(scopeAlias),token=expression(tokenExpression);
 return`(${s}.kind='kol' AND ${s}.account_id IS NULL AND cardinality(${s}.wallet_addresses)=1 AND ${s}.id='kol:'||${s}.wallet_addresses[1]
 AND EXISTS(SELECT 1 FROM fresh.kols history_kol JOIN fresh.wallets history_wallet ON history_wallet.address=history_kol.wallet_address
 WHERE history_kol.wallet_address=${s}.wallet_addresses[1] AND history_kol.is_tracked AND history_wallet.active) AND ${freshGangHistoryAdmissionSql(token)})`;}
export function freshScopeTokenBoundarySql(scopeAlias:string,tokenExpression:string,blockExpression:string,timeExpression:string,options:{allowMissingTime?:boolean}={}){
 const s=identifier(scopeAlias),token=expression(tokenExpression),block=boundaryExpression(blockExpression),time=boundaryExpression(timeExpression),missing=options.allowMissingTime?`${time} IS NULL OR `:'';
 return`((${block}>=${s}.starts_block AND (${missing}${time}>=${s}.starts_at)) OR (${freshGangHistoryScopeSql(s,token)} AND ${block}>=${FRESH_GANG_HISTORY_FROM_BLOCK} AND (${missing}${time}>='${FRESH_GANG_CREATION_TIME}'::timestamptz)))`;}
export function freshScopeEventSql(eventAlias='e',scopeAlias='s'){const e=identifier(eventAlias);return freshScopeTokenBoundarySql(scopeAlias,e+'.token_address',e+'.block_number',e+'.occurred_at');}
export const freshTokenHistoryScopeSql=freshScopeEventSql;
export function freshScopeWalletMonitoringSql(eventAlias:string,scopeAlias:string,walletAlias:string){const e=identifier(eventAlias),w=identifier(walletAlias);
 return`(${e}.block_number>=${w}.monitoring_from_block OR (${freshGangHistoryScopeSql(scopeAlias,e+'.token_address')} AND ${e}.block_number>=${FRESH_GANG_HISTORY_FROM_BLOCK}))`;}
export function freshTrackedTokenSql(alias='t'){
 const t=identifier(alias);return`(${t}.launch_status='eligible' OR (${t}.launch_status='preexisting' AND ${freshExistingTokenAdmissionSql(t+'.address')}))`;
}
export function freshTrackedEventSql(eventAlias='e',tokenAlias='t'){
 const e=identifier(eventAlias),t=identifier(tokenAlias);
 return`(${freshTrackedTokenSql(t)} AND (${t}.launch_status='eligible' OR EXISTS(SELECT 1 FROM fresh.checkpoints event_start WHERE event_start.key='start'
 AND ${e}.block_number>=event_start.block_number+1 AND ${e}.occurred_at>=CASE WHEN pg_input_is_valid(event_start.value->>'startTime','timestamptz') THEN (event_start.value->>'startTime')::timestamptz ELSE NULL END)
 OR (${freshGangHistoryAdmissionSql(e+'.token_address')} AND ${e}.block_number>=${FRESH_GANG_HISTORY_FROM_BLOCK} AND ${e}.occurred_at>='${FRESH_GANG_CREATION_TIME}'::timestamptz)))`;
}
