import{createHash}from'node:crypto';
import type{Pool,PoolClient}from'pg';
import type{FreshEventResult,FreshLot,FreshPosition,FreshScope}from'../../shared/freshAccounting.js';
import{applyFreshEvent,FreshRational,freshEventAccountingEligible,freshEventFromRow,freshEventInScope,freshEventOrder,freshLotFromRow,freshPositionFromRow,freshScopeFromRow,hydrateFreshScopeTokenHistory}from'./accounting.js';
import{FRESH_REALIZED_ESTIMATE_POLICY,FRESH_REALIZED_ESTIMATE_POLICY_KEY,freshRealizedEstimateReady}from'./estimatedProjectionPolicy.js';
import{freshRealizedPolicyReady}from'./realizedPolicy.js';
type Row=Record<string,any>;
export interface FreshEstimateSnapshot{checkpoints:Row[];scopes:Row[];resolvedScopes:FreshScope[];events:Row[];results:Row[];positions:Row[];lots:Row[];kols:Row[];members:Row[];}
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export const freshEstimateProjectionSha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
const q=FreshRational.fromStored,zero=q('0');
const sameQ=(a:string|null,b:string|null)=>a===null?b===null:b!==null&&q(a).compare(q(b))===0;
const without=(r:Row,keys:string[])=>Object.fromEntries(Object.entries(r).filter(([k])=>!keys.includes(k)));
const fingerprints=(s:FreshEstimateSnapshot)=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,freshEstimateProjectionSha(v)]));
const resultFields=['realizedQ','knownRealizedQ','capitalQ','feeQ','volumeQ']as const;
const resultValue=(r:Row):FreshEventResult=>({scopeId:r.scope_id,eventId:r.event_id,tokenAddress:r.token_address,realizedQ:r.realized_q,knownRealizedQ:r.known_realized_q,capitalQ:r.capital_q,feeQ:r.fee_q,feeKey:r.fee_key,tradeCount:r.trade_count,volumeQ:r.volume_q,tokensTrade:r.tokens_trade,occurredAt:new Date(r.occurred_at).toISOString()});
const key=(r:Row)=>r.scope_id+':'+r.event_id;
function assertResult(old:Row,result:FreshEventResult){
 const prior=resultValue(old);for(const f of resultFields)if(!sameQ(prior[f],result[f]))throw Error('estimate_projection_exact_result_mismatch');
 for(const f of['scopeId','eventId','tokenAddress','feeKey','tradeCount','tokensTrade','occurredAt']as const)if(prior[f]!==result[f])throw Error('estimate_projection_result_context_mismatch');
}
/** Replays only affected scopes in memory. The existing exact results are an
 * independent guard: every result, final lot and position must remain identical.
 * This produces display columns; it never replaces a null acquisition basis. */
export function buildFreshEstimateProjection(s:FreshEstimateSnapshot,operatorSha:string){
 if(!/^[a-f0-9]{64}$/.test(operatorSha))throw Error('estimate_projection_operator_sha_required');
 const start=s.checkpoints.find(r=>r.key==='start'),capture=s.checkpoints.find(r=>r.key==='capture'),exact=s.checkpoints.find(r=>r.key==='accounting:realized_policy');
 if(!start?.block_hash||!capture?.block_hash||!freshRealizedPolicyReady(exact?.value)||String(capture.value?.startBlock)!==String(start.block_number)||capture.value?.startHash!==start.block_hash)throw Error('estimate_projection_boundary_invalid');
 const scopeIds=s.scopes.map(r=>r.id);if(new Set(scopeIds).size!==scopeIds.length||s.resolvedScopes.length!==scopeIds.length||s.resolvedScopes.some(r=>!scopeIds.includes(r.id)))throw Error('estimate_projection_scope_context_invalid');
 const oldResults=new Map(s.results.map(r=>[key(r),r])),estimates=new Map<string,string>(),allEvents=s.events.filter(e=>e.canonical).map(freshEventFromRow).sort(freshEventOrder);
 if(oldResults.size!==s.results.length||new Set(allEvents.map(e=>e.id)).size!==allEvents.length)throw Error('estimate_projection_duplicate_identity');
 let replayed=0;
 for(const scope of s.resolvedScopes){
  if(!s.results.some(r=>r.scope_id===scope.id&&r.realized_q===null))throw Error('estimate_projection_unnecessary_scope');
  const events=allEvents.filter(e=>freshEventInScope(scope,e)),positions=new Map<string,FreshPosition>(),lots=new Map<string,FreshLot[]>(),fees=new Map<string,string|null>();
  const found=new Set<string>();
  for(const event of events){
   if(!freshEventAccountingEligible(event))continue;
   const old=oldResults.get(scope.id+':'+event.id);if(!old)throw Error('estimate_projection_missing_original_result');
   const feeSeen=event.feeKey!==null&&fees.has(event.feeKey);if(feeSeen&&(event.feeUsd===null||fees.get(event.feeKey!)===null||!sameQ(fees.get(event.feeKey!)!,event.feeUsd)))throw Error('estimate_projection_conflicting_fee');
   const internal=event.counterparty!==null&&freshEventInScope(scope,{...event,walletAddress:event.counterparty})&&event.kind.startsWith('transfer_');
   const opposite=event.kind==='transfer_in'?'transfer_out':'transfer_in';
   const pairs=internal&&event.transferKey?events.filter(v=>v.transferKey===event.transferKey&&v.kind===opposite&&v.tokenAddress===event.tokenAddress&&v.walletAddress===event.counterparty&&v.counterparty===event.walletAddress):[];
   const paired=pairs.length===1&&sameQ(pairs[0].quantity,event.quantity)&&pairs[0].transactionHash===event.transactionHash&&pairs[0].blockHash===event.blockHash;
   const out=applyFreshEvent(scope,event,{position:event.tokenAddress?positions.get(event.tokenAddress)??null:null,lots:event.tokenAddress?lots.get(event.tokenAddress)??[]:[],feeAlreadyApplied:feeSeen,internalTransferPaired:paired});
   assertResult(old,out.result);if(out.position)positions.set(event.tokenAddress!,out.position);if(event.tokenAddress)lots.set(event.tokenAddress,out.lots);
   if(event.feeKey&&!feeSeen)fees.set(event.feeKey,out.result.feeQ);
   if(out.result.realizedQ===null){if(out.result.estimatedRealizedQ==null)throw Error('estimate_projection_estimate_missing');estimates.set(key(old),out.result.estimatedRealizedQ);}
   found.add(event.id);replayed++;
  }
  if(s.results.some(r=>r.scope_id===scope.id&&!found.has(r.event_id)))throw Error('estimate_projection_orphan_result');
  const oldPositions=s.positions.filter(p=>p.scope_id===scope.id);if(oldPositions.length!==positions.size)throw Error('estimate_projection_position_count_mismatch');
  for(const old of oldPositions){const next=positions.get(old.token_address),prior=freshPositionFromRow(old);if(!next||freshEstimateProjectionSha(without(prior,['revision']))!==freshEstimateProjectionSha(without(next,['revision'])))throw Error('estimate_projection_position_mismatch');}
  const oldLots=s.lots.filter(l=>l.scope_id===scope.id).map(freshLotFromRow).sort((a,b)=>a.id.localeCompare(b.id)),nextLots=[...lots.values()].flat().map(l=>without(l,['knownCostQ'])).sort((a,b)=>a.id.localeCompare(b.id));
  if(freshEstimateProjectionSha(oldLots)!==freshEstimateProjectionSha(nextLots))throw Error('estimate_projection_lot_mismatch');
 }
 const results=s.results.filter(r=>r.realized_q===null).map(r=>({scope_id:r.scope_id,event_id:r.event_id,estimated_realized_q:estimates.get(key(r))!}));
 const kols:Row[]=[];
 for(const kol of s.kols){
  const scope=s.scopes.find(r=>r.kind==='kol'&&r.active&&r.wallet_addresses.length===1&&r.wallet_addresses[0]===kol.wallet_address);
  let estimate:string|null=null;
  if(Number(kol.rolling_unknown_count)>0){
   if(!scope||kol.rolling_as_of===null)throw Error('estimate_projection_rolling_context_missing');
   const at=new Date(kol.rolling_as_of).getTime();if(!Number.isFinite(at))throw Error('estimate_projection_invalid_time');
   const rows=s.results.filter(r=>r.scope_id===scope.id&&new Date(r.occurred_at).getTime()>at-86400000&&new Date(r.occurred_at).getTime()<=at),unknown=rows.filter(r=>r.realized_q===null);
   if(unknown.length!==Number(kol.rolling_unknown_count)||!sameQ(rows.reduce((n,r)=>n.add(q(r.known_realized_q)),zero).exact(),kol.rolling_known_realized_q))throw Error('estimate_projection_rolling_aggregate_mismatch');
   estimate=rows.reduce((n,r)=>{const v=r.realized_q??estimates.get(key(r));if(v==null)throw Error('estimate_projection_rolling_estimate_missing');return n.add(q(v));},zero).exact();
  }
  if((kol.rolling_estimated_realized_q??null)!==estimate)kols.push({wallet_address:kol.wallet_address,rolling_estimated_realized_q:estimate});
 }
 const body={version:1,policy:FRESH_REALIZED_ESTIMATE_POLICY,operatorSha,boundary:{startBlock:String(start.block_number),startHash:start.block_hash,captureRevision:String(capture.revision),captureBlock:String(capture.block_number),captureHash:capture.block_hash},before:fingerprints(s),results,kols,scopeIds,counts:{scopes:scopeIds.length,replayed,results:results.length,kols:kols.length,lots:s.lots.length,positions:s.positions.length}};
 const checkpointSeal=s.checkpoints.map(r=>r.key==='capture'?{key:r.key,revision:String(r.revision),startBlock:r.value?.startBlock,startHash:r.value?.startHash,startTime:r.value?.startTime}:r);
 const seal={...body,boundary:without(body.boundary,['captureBlock','captureHash']),before:{...body.before,checkpoints:freshEstimateProjectionSha(checkpointSeal)}};
 return{...body,planSha256:freshEstimateProjectionSha(seal)};
}
export type FreshEstimateProjection=ReturnType<typeof buildFreshEstimateProjection>;
export async function ensureFreshEstimateProjectionSchema(c:Pick<PoolClient,'query'>){
 await c.query('ALTER TABLE fresh.scope_event_results ADD COLUMN IF NOT EXISTS estimated_realized_q text');
 await c.query('ALTER TABLE fresh.kols ADD COLUMN IF NOT EXISTS rolling_estimated_realized_q text');
}
export async function readFreshEstimateSnapshot(c:Pick<PoolClient,'query'>):Promise<FreshEstimateSnapshot>{
 const limited=async(sql:string,args:unknown[],max:number)=>{const rows=(await c.query(sql+` LIMIT ${max+1}`,args)).rows;if(rows.length>max)throw Error('estimate_projection_capacity_exceeded');return rows;};
 const checkpoints=(await c.query("SELECT * FROM fresh.checkpoints WHERE key IN('start','capture','decode','accounting:realized_policy',$1) OR key LIKE 'token_history_admission:%' ORDER BY key",[FRESH_REALIZED_ESTIMATE_POLICY_KEY])).rows;
 const scopes=await limited('SELECT s.* FROM fresh.accounting_scopes s WHERE EXISTS(SELECT 1 FROM fresh.scope_event_results r WHERE r.scope_id=s.id AND r.realized_q IS NULL) ORDER BY s.id',[],10000),ids=scopes.map(s=>s.id),addresses=[...new Set(scopes.flatMap(s=>s.wallet_addresses))];
 const members=await limited('SELECT user_id::text,wallet_address,activity_from,registration_block FROM public.journal_wallets WHERE user_id::text=ANY($1::text[]) ORDER BY user_id,wallet_address',[[...new Set(scopes.flatMap(s=>s.account_id?[s.account_id]:[]))]],20000);
 const resolvedScopes=scopes.map(freshScopeFromRow);
 for(const scope of resolvedScopes){await hydrateFreshScopeTokenHistory(c,scope);if(scope.accountId){scope.walletStarts=Object.fromEntries(members.filter(m=>m.user_id===scope.accountId).map(m=>[m.wallet_address,{startsAt:new Date(m.activity_from).toISOString(),startsBlock:String(m.registration_block??scope.startsBlock)}]));scope.walletAddresses=scope.walletAddresses.filter(a=>scope.walletStarts![a]);}}
 return{checkpoints,scopes,resolvedScopes,members,events:await limited('SELECT * FROM fresh.financial_events WHERE wallet_address=ANY($1::text[]) ORDER BY id',[addresses],200000),results:await limited('SELECT * FROM fresh.scope_event_results WHERE scope_id=ANY($1::text[]) ORDER BY scope_id,event_id',[ids],500000),positions:await limited('SELECT * FROM fresh.positions WHERE scope_id=ANY($1::text[]) ORDER BY scope_id,token_address',[ids],100000),lots:await limited('SELECT * FROM fresh.open_lots WHERE scope_id=ANY($1::text[]) ORDER BY id',[ids],200000),kols:await limited('SELECT * FROM fresh.kols ORDER BY wallet_address',[],10000)};
}
function preserved(before:FreshEstimateSnapshot,after:FreshEstimateSnapshot){
 const strip=(s:FreshEstimateSnapshot)=>({...s,results:s.results.map(r=>without(r,['estimated_realized_q'])),kols:s.kols.map(r=>without(r,['rolling_estimated_realized_q']))});
 if(freshEstimateProjectionSha(strip(before))!==freshEstimateProjectionSha(strip(after)))throw Error('estimate_projection_original_fields_changed');
}
/** The gate pauses financial writers. Capture/urgent may continue. Caller uses
 * a sealed plan and a canonical capture floor; only nullable display columns
 * and the final readiness checkpoint are written in this transaction. */
export async function runFreshEstimateProjection(pool:Pick<Pool,'connect'>,operatorSha:string,options:{apply?:boolean;planSha256?:string;captureFloor?:{block:string;hash:string}}={}){
 const c=await pool.connect(),started=Date.now();let open=false;
 try{
  await c.query(options.apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');open=true;
  await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL statement_timeout='120s'");
  if((await c.query('SELECT current_database() AS database')).rows[0]?.database!=='kollens_fresh_v14')throw Error('estimate_projection_wrong_database');
  if(options.apply){
   if(!/^[a-f0-9]{64}$/.test(options.planSha256??''))throw Error('estimate_projection_plan_required');
   await c.query('SELECT pg_advisory_xact_lock(73621941)');
   await c.query('LOCK TABLE fresh.financial_events,fresh.open_lots,fresh.positions,fresh.wallets,public.journal_wallets IN SHARE MODE');
   await c.query('LOCK TABLE fresh.scope_event_results,fresh.accounting_scopes,fresh.kols IN SHARE ROW EXCLUSIVE MODE');
   await c.query("SELECT key FROM fresh.checkpoints WHERE key IN('start','capture','decode','accounting:realized_policy',$1) OR key LIKE 'token_history_admission:%' ORDER BY key FOR UPDATE",[FRESH_REALIZED_ESTIMATE_POLICY_KEY]);
  }
  const before=await readFreshEstimateSnapshot(c),marker=before.checkpoints.find(r=>r.key===FRESH_REALIZED_ESTIMATE_POLICY_KEY);
  if(marker){if(!freshRealizedEstimateReady(marker.value))throw Error('estimate_projection_marker_invalid');await c.query('ROLLBACK');open=false;return{at:new Date().toISOString(),status:'already_complete',applicationWrites:0,providerCalls:0};}
  const plan=buildFreshEstimateProjection(before,operatorSha);
  if(!options.apply){await c.query('ROLLBACK');open=false;return{at:new Date().toISOString(),status:'plan',applicationWrites:0,providerCalls:0,elapsedMs:Date.now()-started,plan};}
  if(plan.planSha256!==options.planSha256)throw Error('estimate_projection_plan_changed');
  const floor=options.captureFloor;
  if(!floor||!/^\d{1,20}$/.test(floor.block)||!/^0x[a-f0-9]{64}$/.test(floor.hash)||BigInt(floor.block)<BigInt(plan.boundary.startBlock)||BigInt(plan.boundary.captureBlock)<BigInt(floor.block))throw Error('estimate_projection_capture_floor_invalid');
  const header=(await c.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[floor.block])).rows[0];
  if(header?.block_hash!==floor.hash||plan.boundary.captureBlock===floor.block&&plan.boundary.captureHash!==floor.hash)throw Error('estimate_projection_capture_floor_noncanonical');
  for(const id of plan.scopeIds)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fresh-scope:${id}`]);
  const r=await c.query('UPDATE fresh.scope_event_results r SET estimated_realized_q=v.estimated_realized_q FROM jsonb_to_recordset($1::jsonb) AS v(scope_id text,event_id text,estimated_realized_q text) WHERE r.scope_id=v.scope_id AND r.event_id=v.event_id AND r.realized_q IS NULL',[JSON.stringify(plan.results)]);
  const k=await c.query('UPDATE fresh.kols k SET rolling_estimated_realized_q=v.rolling_estimated_realized_q FROM jsonb_to_recordset($1::jsonb) AS v(wallet_address text,rolling_estimated_realized_q text) WHERE k.wallet_address=v.wallet_address',[JSON.stringify(plan.kols)]);
  if(r.rowCount!==plan.results.length||k.rowCount!==plan.kols.length)throw Error('estimate_projection_write_count_mismatch');
  const after=await readFreshEstimateSnapshot(c);preserved(before,after);
  const rebuilt=buildFreshEstimateProjection(after,operatorSha);if(rebuilt.kols.length||after.results.some(row=>row.realized_q===null&&row.estimated_realized_q!==plan.results.find(r=>key(r)===key(row))?.estimated_realized_q))throw Error('estimate_projection_not_idempotent');
  const audit={version:1,policy:FRESH_REALIZED_ESTIMATE_POLICY,state:'complete',operatorSha,planSha256:plan.planSha256,completedAt:new Date().toISOString(),boundary:plan.boundary,counts:plan.counts,before:plan.before,after:fingerprints(after),financialFactsExact:true,exactResultsUnchanged:true,openLotsExact:true,settingsUntouched:true};
  await c.query('INSERT INTO fresh.checkpoints(key,value) VALUES($1,$2::jsonb)',[FRESH_REALIZED_ESTIMATE_POLICY_KEY,JSON.stringify(audit)]);
  await c.query('COMMIT');open=false;return{at:new Date().toISOString(),status:'complete',providerCalls:0,applicationWrites:plan.results.length+plan.kols.length+1,elapsedMs:Date.now()-started,audit};
 }catch(e){if(open)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
