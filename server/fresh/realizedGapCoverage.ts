import{createHash}from'node:crypto';
import type{PoolClient}from'pg';
import{decodeFreshEvidence,validateFreshReceipt,type FreshCapturedReceipt}from'./capture.js';
import{freshKnownProtocolTokenBirthSql}from'./tokenBirth.js';
import{FRESH_REALIZED_POLICY}from'./realizedPolicy.js';

export const FRESH_REALIZED_GAP_PREFIX='coverage:realized_gap:';
export const FRESH_REALIZED_GAP_TTL_MS=72*3600000;
const iso=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
const address=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{40}$/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=(v:unknown)=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:stable(v)).digest('hex');
const same=(a:unknown,b:unknown)=>stable(a)===stable(b);
export interface FreshRealizedGapHeader{number:number;hash:string;parentHash:string;timestamp:string;capturedAt:string}
export type FreshRealizedGapChainHeader=Omit<FreshRealizedGapHeader,'capturedAt'>;
export interface FreshRealizedGapContext{
 start:{number:number;hash:string;timestamp:string};captureRevision:string;
 wallet:{address:string;revision:string;active:boolean;monitoringFrom:number;monitoringTo:number|null;gapFrom:number;gapReason:string};
 scope:{id:string;kind:string;accountId:string|null;walletAddresses:string[];startsBlock:number;startsAt:string;active:boolean};
}
export type FreshRealizedGapSourceContext=Omit<FreshRealizedGapContext,'wallet'>&{wallet:Omit<FreshRealizedGapContext['wallet'],'gapFrom'|'gapReason'>};
export function freshRealizedGapSourceMembership(c:FreshRealizedGapContext|FreshRealizedGapSourceContext){
 const{gapFrom:_gapFrom,gapReason:_gapReason,...wallet}=c.wallet as FreshRealizedGapContext['wallet'];return{...c,wallet};
}
export interface FreshRealizedGapAttestation{
 version:1;kind:'finite_realized_gap_coverage_v1';policy:typeof FRESH_REALIZED_POLICY;
 context:FreshRealizedGapContext;upper:FreshRealizedGapHeader;activationDeadline:string;activatedAt:string;expiryGuardVersion:1;
 source:{kind:'pre_expiry_complete_captured_cohort_v1';snapshotAt:string;preservedAt:string;receiptCount:number;walletReceiptCount:number;
  cohortSha256:string;headerChainSha256:string;sourceManifestSha256:string;earliestOriginalExpiry:string};
 invalidatedAt?:string;invalidationReason?:string;
}
export function freshRealizedGapKey(wallet:string){if(!address(wallet))throw Error('gap_wallet_invalid');return FRESH_REALIZED_GAP_PREFIX+wallet;}
function validContext(c:FreshRealizedGapContext){return c&&integer(c.start?.number)&&hash(c.start.hash)&&iso(c.start.timestamp)&&revision(c.captureRevision)
 &&address(c.wallet?.address)&&revision(c.wallet.revision)&&c.wallet.active&&integer(c.wallet.monitoringFrom)&&(c.wallet.monitoringTo===null||integer(c.wallet.monitoringTo))
 &&integer(c.wallet.gapFrom)&&c.wallet.gapFrom>=c.wallet.monitoringFrom&&c.wallet.gapReason==='expired_undecoded_evidence'
 &&c.scope?.id==='kol:'+c.wallet.address&&c.scope.kind==='kol'&&c.scope.accountId===null&&c.scope.active&&same(c.scope.walletAddresses,[c.wallet.address])
 &&integer(c.scope.startsBlock)&&iso(c.scope.startsAt)&&c.scope.startsBlock===c.wallet.monitoringFrom&&c.scope.startsBlock>c.start.number&&c.scope.startsAt>=c.start.timestamp;}
function validHeader(h:FreshRealizedGapHeader){return h&&integer(h.number)&&hash(h.hash)&&hash(h.parentHash)&&iso(h.timestamp)&&iso(h.capturedAt);}
export function validFreshRealizedGapAttestation(a:FreshRealizedGapAttestation,context:FreshRealizedGapContext,now:string){
 try{return a?.version===1&&a.kind==='finite_realized_gap_coverage_v1'&&a.policy===FRESH_REALIZED_POLICY&&validContext(context)&&same(a.context,context)
  &&validHeader(a.upper)&&a.upper.number>=context.wallet.gapFrom&&a.upper.timestamp>=context.start.timestamp&&iso(a.activationDeadline)&&iso(a.activatedAt)&&iso(now)&&a.activatedAt<=now
  &&a.expiryGuardVersion===1&&a.activatedAt<a.activationDeadline&&a.activationDeadline<=new Date(Date.parse(a.upper.capturedAt)+FRESH_REALIZED_GAP_TTL_MS).toISOString()&&a.invalidatedAt===undefined&&a.invalidationReason===undefined
  &&a.source?.kind==='pre_expiry_complete_captured_cohort_v1'&&iso(a.source.snapshotAt)&&a.source.snapshotAt>=a.upper.capturedAt&&iso(a.source.preservedAt)&&iso(a.source.earliestOriginalExpiry)
  &&a.source.snapshotAt<=a.source.preservedAt&&a.source.preservedAt<=a.activatedAt&&a.source.preservedAt<a.source.earliestOriginalExpiry&&integer(a.source.receiptCount)&&a.source.receiptCount>0&&a.source.receiptCount<=5000
  &&integer(a.source.walletReceiptCount)&&a.source.walletReceiptCount>0&&a.source.walletReceiptCount<=a.source.receiptCount
  &&[a.source.cohortSha256,a.source.headerChainSha256,a.source.sourceManifestSha256].every(s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s));
 }catch{return false;}
}
/** Offline operator PLAN only. The independently reviewed source SELECT must be
 * the complete captured cohort for these public memberships through upper.
 * Bind every original checksum/TTL and every contiguous header, never a sample.
 * This attests an existence bound; it neither approves lost economics nor
 * changes any financial fact, result, lot, gap or wallet membership. */
export function planFreshRealizedGapCoverage(input:{context:FreshRealizedGapContext;sourceContext:FreshRealizedGapSourceContext;upper:FreshRealizedGapHeader;sourceSnapshotAt:string;headers:FreshRealizedGapChainHeader[];
 receipts:{payload:Buffer;blockNumber:number;blockHash:string;expiresAt:string}[];manifest:{transactionHash:string;blockHash:string;coreSha256:string;expiresAt:string}[];
 preservedAt:string;sourceManifestSha256:string;now:string;guard:{ok:boolean;updatedAt:string;version:number}}){
 const{context,upper}=input;if(!validContext(context)||!same(freshRealizedGapSourceMembership(context),freshRealizedGapSourceMembership(input.sourceContext))||!validHeader(upper)||!iso(input.now)||!iso(input.preservedAt)||!iso(input.sourceSnapshotAt)||input.sourceSnapshotAt<upper.capturedAt
  ||!/^[0-9a-f]{64}$/.test(input.sourceManifestSha256)||input.headers.length!==upper.number-context.start.number||input.headers.length>1000000
  ||!input.receipts.length||input.receipts.length>5000||input.receipts.length!==input.manifest.length||input.guard?.ok!==true||input.guard.version!==1||!iso(input.guard.updatedAt)
  ||input.guard.updatedAt>input.now||Date.parse(input.now)-Date.parse(input.guard.updatedAt)>120000)throw Error('gap_source_context_invalid');
 let previous=context.start.hash;const byNumber=new Map<number,FreshRealizedGapChainHeader>();for(let i=0;i<input.headers.length;i++){const h=input.headers[i];if(!integer(h.number)||!hash(h.hash)||!hash(h.parentHash)||!iso(h.timestamp)||h.number!==context.start.number+i+1||h.parentHash!==previous)throw Error('gap_source_chain_invalid');previous=h.hash;byNumber.set(h.number,h);}const{capturedAt:_capturedAt,...upperChain}=upper;if(!same(input.headers.at(-1),upperChain))throw Error('gap_source_upper_invalid');
 const manifest=new Map(input.manifest.map(r=>[r.transactionHash+':'+r.blockHash,r]));if(manifest.size!==input.manifest.length)throw Error('gap_source_manifest_duplicate');const seen=new Set<string>(),cores:unknown[]=[],expiry:string[]=[];let walletReceiptCount=0;
 for(const row of input.receipts){const entry:FreshCapturedReceipt=decodeFreshEvidence(row.payload),h=byNumber.get(row.blockNumber),key=entry.transaction.hash+':'+row.blockHash,m=manifest.get(key);if(!h||seen.has(key)||!m||row.blockNumber>upper.number||row.blockNumber<context.wallet.gapFrom&&entry.wallets.includes(context.wallet.address)
   ||row.blockHash!==h.hash||row.blockHash!==entry.receipt.blockHash||!iso(row.expiresAt)||m.expiresAt!==row.expiresAt||!iso(entry.observedAt)
   ||Date.parse(row.expiresAt)!==Date.parse(entry.observedAt)+FRESH_REALIZED_GAP_TTL_MS||input.preservedAt>=row.expiresAt)throw Error('gap_source_receipt_invalid');
  validateFreshReceipt(entry.receipt,entry.transaction,{number:'0x'+h.number.toString(16),hash:h.hash,parentHash:h.parentHash,timestamp:'0x'+Math.floor(Date.parse(h.timestamp)/1000).toString(16),transactions:[]});
  const core=sha(JSON.stringify([entry.transaction,entry.receipt,entry.wallets,entry.historicalWallets??null,entry.observedAt]));if(core!==m.coreSha256)throw Error('gap_source_core_mismatch');seen.add(key);expiry.push(row.expiresAt);if(entry.wallets.includes(context.wallet.address))walletReceiptCount++;cores.push([key,row.blockNumber,core,row.expiresAt]);
 }
 const activationDeadline=new Date(Date.parse(upper.capturedAt)+FRESH_REALIZED_GAP_TTL_MS).toISOString();if(input.now>=activationDeadline)throw Error('gap_guard_activation_late');
 const attestation:FreshRealizedGapAttestation={version:1,kind:'finite_realized_gap_coverage_v1',policy:FRESH_REALIZED_POLICY,context:structuredClone(context),upper:{...upper},activationDeadline,activatedAt:input.now,expiryGuardVersion:1,source:{kind:'pre_expiry_complete_captured_cohort_v1',snapshotAt:input.sourceSnapshotAt,preservedAt:input.preservedAt,receiptCount:input.receipts.length,walletReceiptCount,cohortSha256:sha(cores.sort((a,b)=>stable(a).localeCompare(stable(b)))),headerChainSha256:sha(input.headers),sourceManifestSha256:input.sourceManifestSha256,earliestOriginalExpiry:expiry.sort()[0]}};
 if(!validFreshRealizedGapAttestation(attestation,context,input.now))throw Error('gap_attestation_invalid');const checkpoint={key:freshRealizedGapKey(context.wallet.address),blockNumber:upper.number,blockHash:upper.hash,value:attestation};return{...checkpoint,sha256:sha(checkpoint)};
}
const ident=(v:string)=>{if(!/^[a-z_][a-z0-9_]*$/i.test(v))throw Error('gap_sql_alias_invalid');return v;};
const stamp=(v:string)=>`to_char((${v}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const contextSql=(s:string,w:string,start:string,capture:string)=>`jsonb_build_object('start',jsonb_build_object('number',${start}.block_number,'hash',${start}.block_hash,'timestamp',${start}.value->>'startTime'),
 'captureRevision',${capture}.revision::text,'wallet',jsonb_build_object('address',${w}.address,'revision',${w}.revision::text,'active',${w}.active,'monitoringFrom',${w}.monitoring_from_block,'monitoringTo',${w}.monitoring_to_block,'gapFrom',${w}.decode_gap_from_block,'gapReason',${w}.decode_gap_reason),
 'scope',jsonb_build_object('id',${s}.id,'kind',${s}.kind,'accountId',${s}.account_id,'walletAddresses',to_jsonb(${s}.wallet_addresses),'startsBlock',${s}.starts_block,'startsAt',${stamp(s+'.starts_at')},'active',${s}.active))`;
const upperSql=(b:string)=>`jsonb_build_object('number',${b}.block_number,'hash',${b}.block_hash,'parentHash',${b}.parent_hash,'timestamp',${stamp(b+'.occurred_at')},'capturedAt',${stamp(b+'.captured_at')})`;
const sourceSql=(v:string,b:string)=>`${v}->'source'->>'kind'='pre_expiry_complete_captured_cohort_v1'
 AND ${v}->'source'->>'snapshotAt'>=${stamp(b+'.captured_at')} AND ${v}->'source'->>'snapshotAt'<=${v}->'source'->>'preservedAt'
 AND ${v}->'source'->>'preservedAt'<=${v}->>'activatedAt' AND ${v}->'source'->>'preservedAt'<${v}->'source'->>'earliestOriginalExpiry'
 AND jsonb_typeof(${v}->'source'->'receiptCount')='number' AND ${v}->'source'->'receiptCount'>'0'::jsonb AND ${v}->'source'->'receiptCount'<='5000'::jsonb
 AND jsonb_typeof(${v}->'source'->'walletReceiptCount')='number' AND ${v}->'source'->'walletReceiptCount'>'0'::jsonb
 AND ${v}->'source'->'walletReceiptCount'<=${v}->'source'->'receiptCount'
 AND ${v}->'source'->>'cohortSha256'~'^[0-9a-f]{64}$' AND ${v}->'source'->>'headerChainSha256'~'^[0-9a-f]{64}$' AND ${v}->'source'->>'sourceManifestSha256'~'^[0-9a-f]{64}$'`;
/** Only rolling realized readiness. Existing unknown-result, pending receipt,
 * pending trade, policy and aggregate freshness gates remain in the caller. */
export function freshRealizedGapIrrelevantSql(scopeAlias='s',walletAlias='w',from='$1',to='$2'){
 const s=ident(scopeAlias),w=ident(walletAlias);if(!/^\$[1-9][0-9]*$/.test(from)||!/^\$[1-9][0-9]*$/.test(to))throw Error('gap_sql_window_invalid');
 return`EXISTS(SELECT 1 FROM fresh.checkpoints gap_bound
 JOIN fresh.checkpoints gap_start ON gap_start.key='start' JOIN fresh.checkpoints gap_capture ON gap_capture.key='capture'
 JOIN fresh.checkpoints gap_maintenance ON gap_maintenance.key='health:maintenance'
 JOIN fresh.recent_blocks gap_anchor ON gap_anchor.block_number=gap_bound.block_number AND gap_anchor.block_hash=gap_bound.block_hash
 WHERE gap_bound.key='${FRESH_REALIZED_GAP_PREFIX}'||${w}.address AND gap_bound.value->'version'='1'::jsonb
 AND gap_bound.value->>'kind'='finite_realized_gap_coverage_v1' AND gap_bound.value->>'policy'='${FRESH_REALIZED_POLICY}'
 AND NOT(gap_bound.value ? 'invalidatedAt') AND NOT(gap_bound.value ? 'invalidationReason')
 AND ${s}.id='kol:'||${w}.address AND ${s}.kind='kol' AND ${s}.account_id IS NULL AND ${s}.active AND ${s}.wallet_addresses=ARRAY[${w}.address]::text[]
 AND ${w}.active AND ${w}.decode_gap_reason='expired_undecoded_evidence' AND ${w}.decode_gap_from_block IS NOT NULL
 AND gap_bound.value->'context'=${contextSql(s,w,'gap_start','gap_capture')}
 AND gap_bound.value->'upper'=${upperSql('gap_anchor')}
 AND gap_bound.block_number>=${w}.decode_gap_from_block AND gap_capture.block_number>=gap_bound.block_number
 AND gap_anchor.occurred_at<=${from}::timestamptz AND ${to}::timestamptz-${from}::timestamptz=interval '24 hours'
 AND ${sourceSql('gap_bound.value','gap_anchor')}
 AND gap_bound.value->'expiryGuardVersion'='1'::jsonb AND gap_bound.value->>'activatedAt'~'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
 AND gap_bound.value->>'activationDeadline'=${stamp("gap_anchor.captured_at+interval '72 hours'")}
 AND gap_bound.value->>'activatedAt'<gap_bound.value->>'activationDeadline' AND gap_bound.value->>'activatedAt'<=${stamp('clock_timestamp()')}
 AND gap_maintenance.value->'ok'='true'::jsonb AND gap_maintenance.value->'result'->'realizedGapExpiryGuardVersion'='1'::jsonb
 AND gap_maintenance.updated_at>clock_timestamp()-interval '120 seconds' AND gap_maintenance.updated_at<=clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM fresh.financial_events gap_event LEFT JOIN fresh.scope_event_results gap_result
  ON gap_result.scope_id=${s}.id AND gap_result.event_id=gap_event.id WHERE gap_event.canonical AND gap_event.wallet_address=${w}.address
  AND gap_event.block_number>=${s}.starts_block AND gap_event.occurred_at>=${s}.starts_at
  AND gap_event.occurred_at>${from}::timestamptz AND gap_event.occurred_at<=${to}::timestamptz
  AND(gap_result.event_id IS NULL OR gap_result.token_address IS DISTINCT FROM gap_event.token_address OR gap_result.occurred_at<>gap_event.occurred_at
   OR gap_result.realized_q IS NULL OR gap_result.fee_q IS NULL OR gap_event.fee_usd IS NULL
   OR gap_event.kind IN('buy','sell') AND(gap_event.amount_usd IS NULL OR NOT EXISTS(SELECT 1 FROM fresh.launch_facts gap_birth
    JOIN fresh.recent_blocks gap_born ON gap_born.block_number=gap_birth.block_number AND gap_born.block_hash=gap_birth.block_hash
    WHERE gap_birth.token_address=gap_event.token_address AND gap_birth.status='eligible' AND gap_birth.block_number>gap_bound.block_number
    AND ${freshKnownProtocolTokenBirthSql('gap_birth','gap_born','gap_start')}))))
 )`;
}
/** Expiry owns this ordinary transaction. No raw evidence or financial values
 * are copied; even an unrelated new unresolved expiry invalidates the bound. */
export async function invalidateFreshRealizedGapCoverage(client:Pick<PoolClient,'query'>,wallets:string[],blockNumber:number,now:Date){
 const keys=[...new Set(wallets.filter(address))].map(freshRealizedGapKey);if(!keys.length)return;
 await client.query(`UPDATE fresh.checkpoints SET value=value||jsonb_build_object('invalidatedAt',$2::text,'invalidationReason','new_unresolved_evidence_expiry'),revision=revision+1,updated_at=clock_timestamp()
 WHERE key=ANY($1::text[]) AND block_number<$3 AND value->>'kind'='finite_realized_gap_coverage_v1' AND NOT(value ? 'invalidatedAt')`,[keys,now.toISOString(),blockNumber]);
}
/** At most two currently active finite attestations may retain their anchors.
 * Expired/invalidated/private or changed membership checkpoints retain nothing. */
export function freshRealizedGapPinnedHeadersSql(blockAlias='b'){
 const b=ident(blockAlias);return`EXISTS(SELECT 1 FROM(SELECT gap_pin.block_number,gap_pin.block_hash FROM fresh.checkpoints gap_pin
 JOIN fresh.wallets gap_wallet ON gap_pin.key='${FRESH_REALIZED_GAP_PREFIX}'||gap_wallet.address
 JOIN fresh.accounting_scopes gap_scope ON gap_scope.id='kol:'||gap_wallet.address AND gap_scope.kind='kol' AND gap_scope.account_id IS NULL AND gap_scope.active AND gap_scope.wallet_addresses=ARRAY[gap_wallet.address]::text[]
 JOIN fresh.checkpoints pin_start ON pin_start.key='start' JOIN fresh.checkpoints pin_capture ON pin_capture.key='capture'
 JOIN fresh.recent_blocks pin_anchor ON pin_anchor.block_number=gap_pin.block_number AND pin_anchor.block_hash=gap_pin.block_hash
 WHERE gap_pin.value->>'kind'='finite_realized_gap_coverage_v1' AND gap_pin.value->'version'='1'::jsonb AND NOT(gap_pin.value ? 'invalidatedAt')
 AND NOT(gap_pin.value ? 'invalidationReason') AND gap_pin.value->>'policy'='${FRESH_REALIZED_POLICY}' AND gap_pin.value->'expiryGuardVersion'='1'::jsonb
 AND gap_wallet.active AND gap_wallet.decode_gap_reason='expired_undecoded_evidence' AND gap_wallet.decode_gap_from_block IS NOT NULL
 AND gap_pin.value->'context'=${contextSql('gap_scope','gap_wallet','pin_start','pin_capture')}
 AND gap_pin.value->'upper'=${upperSql('pin_anchor')} AND pin_capture.block_number>=gap_pin.block_number
 AND ${sourceSql('gap_pin.value','pin_anchor')}
 AND gap_pin.value->>'activationDeadline'=${stamp("pin_anchor.captured_at+interval '72 hours'")}
 AND gap_pin.value->>'activatedAt'~'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
 AND gap_pin.value->>'activatedAt'<gap_pin.value->>'activationDeadline' AND gap_pin.value->>'activatedAt'<=${stamp('clock_timestamp()')}
 ORDER BY gap_pin.key LIMIT 2) active_gap_pin WHERE active_gap_pin.block_number=${b}.block_number AND active_gap_pin.block_hash=${b}.block_hash)`;
}
