import{createHash}from'node:crypto';import type{Pool}from'pg';
import{GANG_TOKEN_ADDRESS,freshGangHistoryScopeSql,readFreshGangHistoryAdmission,freshGangHistoryPermissionDigest,type FreshGangHistoryPermission}from'./tracking.js';
export const FRESH_GANG_TOKEN_COVERAGE_KEY='token_coverage:'+GANG_TOKEN_ADDRESS,FRESH_GANG_TOKEN_COVERAGE_ORIGIN=129698501;
type Block={number:number;hash:string;timestamp:string};
export interface FreshGangTokenCoverage{version:1;kind:'public_token_transfer_coverage';chainId:56;tokenAddress:typeof GANG_TOKEN_ADDRESS;confirmations:6;headBlock:number;
 origin:Block;through:Block;historyPermission:FreshGangHistoryPermission;historyPermissionDigest:string;walletAddresses:string[];rosterSha256:string;
 ranges:{fromBlock:number;throughBlock:number;fromHash:string;throughHash:string}[];sourceEvidenceSha256:string;captureComplete:true;observedAt:string;
 feeCoverage:{kind:'captured_monitored_transactions';sourceStartBlock:number;sourceCapture:Block;fromBlock:number;throughBlock:number;rosterSha256:string;sourceEvidenceSha256:string;complete:true}}
const hash=(x:unknown):x is string=>typeof x==='string'&&/^0x[0-9a-f]{64}$/.test(x),sha=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const iso=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const block=(b:Block)=>b&&Number.isSafeInteger(b.number)&&hash(b.hash)&&iso(b.timestamp),digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function validFreshGangTokenCoverage(value:unknown,permission:FreshGangHistoryPermission):value is FreshGangTokenCoverage{
 try{const v=value as FreshGangTokenCoverage;if(!v||v.version!==1||v.kind!=='public_token_transfer_coverage'||v.chainId!==56||v.tokenAddress!==GANG_TOKEN_ADDRESS||v.confirmations!==6||v.captureComplete!==true
  ||!block(v.origin)||v.origin.number!==FRESH_GANG_TOKEN_COVERAGE_ORIGIN||!block(v.through)||v.through.number<=v.origin.number||v.through.number-v.origin.number>131072||Date.parse(v.through.timestamp)<Date.parse(v.origin.timestamp)
  ||!Number.isSafeInteger(v.headBlock)||v.headBlock<v.through.number+6||!iso(v.observedAt)||Date.parse(v.observedAt)<Date.parse(v.through.timestamp)||!sha(v.sourceEvidenceSha256)
  ||JSON.stringify(historyFields.map(k=>v.historyPermission?.[k as keyof FreshGangHistoryPermission]))!==JSON.stringify(historyFields.map(k=>permission[k as keyof FreshGangHistoryPermission]))||Object.keys(v.historyPermission??{}).length!==14||v.historyPermissionDigest!==freshGangHistoryPermissionDigest(permission)||!sha(v.rosterSha256)||!Array.isArray(v.walletAddresses)||v.walletAddresses.length!==226
  ||v.walletAddresses.some(a=>!/^0x[0-9a-f]{40}$/.test(a))||new Set(v.walletAddresses).size!==226||JSON.stringify(v.walletAddresses)!==JSON.stringify([...v.walletAddresses].sort())||digest(v.walletAddresses)!==v.rosterSha256
  ||!Array.isArray(v.ranges)||!v.ranges.length||v.ranges.length>16||Buffer.byteLength(JSON.stringify(v))>64*1024)return false;
  const fee=v.feeCoverage;if(!fee||fee.kind!=='captured_monitored_transactions'||fee.complete!==true||!Number.isSafeInteger(fee.sourceStartBlock)||fee.sourceStartBlock>v.origin.number
   ||!block(fee.sourceCapture)||fee.sourceCapture.number<v.through.number||Date.parse(fee.sourceCapture.timestamp)<Date.parse(v.through.timestamp)||Date.parse(v.observedAt)<Date.parse(fee.sourceCapture.timestamp)||fee.fromBlock!==v.origin.number+1||fee.throughBlock!==v.through.number||fee.rosterSha256!==v.rosterSha256||!sha(fee.sourceEvidenceSha256))return false;
  let next=v.origin.number+1;for(const r of v.ranges){if(!Number.isSafeInteger(r.fromBlock)||!Number.isSafeInteger(r.throughBlock)||r.fromBlock!==next||r.throughBlock<r.fromBlock||r.throughBlock-r.fromBlock>=8192||!hash(r.fromHash)||!hash(r.throughHash))return false;next=r.throughBlock+1;}
  return next===v.through.number+1&&v.ranges.at(-1)!.throughHash===v.through.hash;
 }catch{return false;}
}
const id=(s:string)=>{if(!/^[a-z_][a-z0-9_]*$/i.test(s))throw Error('token_coverage_sql_alias');return s;};
const expr=(s:string)=>{if(!/^(?:(?:[a-z_][a-z0-9_]*\.){1,2}[a-z_][a-z0-9_]*|\$[1-9][0-9]*)$/i.test(s))throw Error('token_coverage_sql_expression');return s;};
const n=(s:string)=>`(CASE WHEN (${s}) ~ '^[0-9]{1,9}$' THEN (${s})::bigint ELSE NULL END)`;
const typedArray=(s:string)=>`CASE WHEN jsonb_typeof(${s})='array' THEN ${s} ELSE '[]'::jsonb END`;
const sqlIso=(s:string)=>`((${s}) ~ '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' AND CASE WHEN pg_input_is_valid(${s},'timestamptz') THEN to_char((${s})::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=${s} ELSE false END)`;
const historyFields=['version','kind','chainId','tokenAddress','active','startBlock','startHash','startTime','historyFromBlock','historyFromHash','historyFromTime','sourceDatasetSha256','approvedAt','policy'];
/** Only a fully attested finite GANG continuation may outrun global capture.
 * Its current row holds references/ranges, never a financial response copy. */
export function freshScopeTokenCaptureSql(scopeAlias='s',tokenExpression='p.token_address'){
 const s=id(scopeAlias),token=expr(tokenExpression),v='token_tail.value',origin=n(v+"#>>'{origin,number}'"),end=n(v+"#>>'{through,number}'"),ranges=typedArray(v+"->'ranges'"),wallets=typedArray(v+"->'walletAddresses'");
 const permissionDigest=`encode(sha256(convert_to(replace(jsonb_build_array(${historyFields.map(k=>`jsonb_build_array('${k}',history_permission.value->'${k}')`).join(',')})::text,' ',''),'UTF8')),'hex')`;
 return`greatest(COALESCE((SELECT block_number FROM fresh.checkpoints WHERE key='capture'),0),COALESCE((SELECT token_tail.block_number FROM fresh.checkpoints token_tail
 JOIN fresh.checkpoints history_permission ON history_permission.key='token_history_admission:${GANG_TOKEN_ADDRESS}'
 JOIN fresh.recent_blocks token_tail_origin ON token_tail_origin.block_number=${origin} AND token_tail_origin.block_hash=${v}#>>'{origin,hash}'
 JOIN fresh.recent_blocks token_tail_end ON token_tail_end.block_number=${end} AND token_tail_end.block_hash=${v}#>>'{through,hash}'
 WHERE token_tail.key='${FRESH_GANG_TOKEN_COVERAGE_KEY}' AND ${freshGangHistoryScopeSql(s,token)} AND pg_column_size(${v})<=65536
 AND ${v} @> '{"version":1,"kind":"public_token_transfer_coverage","chainId":56,"tokenAddress":"${GANG_TOKEN_ADDRESS}","confirmations":6,"captureComplete":true}'::jsonb
 AND ${origin}=${FRESH_GANG_TOKEN_COVERAGE_ORIGIN} AND ${end}>${origin} AND ${end}<=${origin}+131072 AND token_tail.block_number=${end} AND token_tail.block_hash=${v}#>>'{through,hash}'
 AND ${n(v+"->>'headBlock'")}>=${end}+6 AND ${v}->'historyPermission'=history_permission.value AND ${v}->>'historyPermissionDigest'=${permissionDigest}
 AND ${v}#>>'{origin,timestamp}'=to_char(token_tail_origin.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 AND ${v}#>>'{through,timestamp}'=to_char(token_tail_end.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND token_tail_end.occurred_at>=token_tail_origin.occurred_at
 AND ${v}->>'sourceEvidenceSha256' ~ '^[0-9a-f]{64}$' AND ${v}->>'rosterSha256'=encode(sha256(convert_to(replace(${wallets}::text,' ',''),'UTF8')),'hex')
 AND ${v}->'feeCoverage' @> '{"kind":"captured_monitored_transactions","complete":true}'::jsonb
 AND ${n(v+"#>>'{feeCoverage,sourceStartBlock}'")}<=${origin} AND ${n(v+"#>>'{feeCoverage,sourceStartBlock}'")}>0
 AND ${n(v+"#>>'{feeCoverage,sourceCapture,number}'")}>=${end} AND ${v}#>>'{feeCoverage,sourceCapture,hash}' ~ '^0x[0-9a-f]{64}$'
 AND ${n(v+"#>>'{feeCoverage,fromBlock}'")}=${origin}+1 AND ${n(v+"#>>'{feeCoverage,throughBlock}'")}=${end}
 AND ${v}#>>'{feeCoverage,rosterSha256}'=${v}->>'rosterSha256' AND ${v}#>>'{feeCoverage,sourceEvidenceSha256}' ~ '^[0-9a-f]{64}$'
 AND ${sqlIso(v+"#>>'{feeCoverage,sourceCapture,timestamp}'")}
 AND CASE WHEN pg_input_is_valid(${v}#>>'{feeCoverage,sourceCapture,timestamp}','timestamptz') THEN (${v}#>>'{feeCoverage,sourceCapture,timestamp}')::timestamptz>=token_tail_end.occurred_at ELSE false END
 AND jsonb_array_length(${wallets})=226 AND ${wallets} @> to_jsonb(${s}.wallet_addresses)
 AND(SELECT count(DISTINCT a) FROM jsonb_array_elements_text(${wallets}) a)=226 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(${wallets}) a WHERE a!~'^0x[0-9a-f]{40}$')
 AND ${wallets}=(SELECT jsonb_agg(a ORDER BY a) FROM jsonb_array_elements_text(${wallets}) a)
 AND jsonb_array_length(${ranges}) BETWEEN 1 AND 16
 AND NOT EXISTS(SELECT 1 FROM(SELECT r,ord,lag(${n("r->>'throughBlock'")}) OVER(ORDER BY ord) prior FROM jsonb_array_elements(${ranges})WITH ORDINALITY ranged(r,ord)) validated
 LEFT JOIN fresh.recent_blocks range_from ON range_from.block_number=${n("r->>'fromBlock'")} AND range_from.block_hash=r->>'fromHash'
 LEFT JOIN fresh.recent_blocks range_through ON range_through.block_number=${n("r->>'throughBlock'")} AND range_through.block_hash=r->>'throughHash'
 WHERE range_from.block_number IS NULL OR range_through.block_number IS NULL OR ${n("r->>'fromBlock'")}<>coalesce(prior,${origin})+1
 OR ${n("r->>'throughBlock'")}<${n("r->>'fromBlock'")} OR ${n("r->>'throughBlock'")}-${n("r->>'fromBlock'")}>=8192)
 AND ${n(v+"#>>'{ranges,-1,throughBlock}'")}=${end} AND ${v}#>>'{ranges,-1,throughHash}'=token_tail.block_hash
 AND jsonb_typeof(${v}->'observedAt')='string' AND ${sqlIso(v+"->>'observedAt'")} AND CASE WHEN pg_input_is_valid(${v}->>'observedAt','timestamptz') AND pg_input_is_valid(${v}#>>'{feeCoverage,sourceCapture,timestamp}','timestamptz') THEN (${v}->>'observedAt')::timestamptz>=greatest(token_tail_end.occurred_at,(${v}#>>'{feeCoverage,sourceCapture,timestamp}')::timestamptz) ELSE false END),0))`;
}
export async function readFreshScopeTokenCapture(db:Pick<Pool,'query'>,scopeId:string,token:string){
 const row=(await db.query(`SELECT ${freshScopeTokenCaptureSql('s','$2')}::text AS block_number FROM fresh.accounting_scopes s WHERE s.id=$1 AND s.active`,[scopeId,token])).rows[0];
 if(!row?.block_number)return null;const b=(await db.query('SELECT block_number::text,block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1',[row.block_number])).rows[0];return b?{number:Number(b.block_number),hash:b.block_hash,timestamp:new Date(b.occurred_at).toISOString()}:null;
}
export async function readFreshGangTokenCoverage(db:Pick<Pool,'query'>){const history=await readFreshGangHistoryAdmission(db);if(!history)return null;const row=(await db.query('SELECT * FROM fresh.checkpoints WHERE key=$1',[FRESH_GANG_TOKEN_COVERAGE_KEY])).rows[0];if(!row||!validFreshGangTokenCoverage(row.value,history.permission)||Number(row.block_number)!==row.value.through.number||row.block_hash!==row.value.through.hash)return null;
 const c=row.value as FreshGangTokenCoverage,expected=new Map<number,string>([[c.origin.number,c.origin.hash],[c.through.number,c.through.hash]]);for(const r of c.ranges){expected.set(r.fromBlock,r.fromHash);expected.set(r.throughBlock,r.throughHash);}const headers=(await db.query('SELECT block_number::text,block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=ANY($1::bigint[])',[[...expected.keys()]])).rows;if(headers.length!==expected.size||headers.some(h=>expected.get(Number(h.block_number))!==h.block_hash))return null;
 for(const b of[c.origin,c.through])if(!headers.some(h=>Number(h.block_number)===b.number&&new Date(h.occurred_at).toISOString()===b.timestamp))return null;return c;}
