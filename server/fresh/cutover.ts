import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import type {Pool,PoolClient} from 'pg';
import type {Rpc} from '../rpc.js';
import {ensureFreshSchema} from './schema.js';
import {freshPortfolioScope} from './portfolio.js';
import {freshConfirmedPriceBlock,type FreshPriceBlock} from './pricing.js';
import {kolProfileTokenSql} from '../kolProfileToken.js';

export const freshCutoverTables=['auth_users','watch_sessions','auth_bot_login_attempts','auth_sessions','auth_login_attempts',
  'auth_bot_login_updates','auth_bot_login_pacing','auth_telegram_avatars','watch_entries','account_watch_entries',
  'creator_claims','creator_profiles','creator_challenges','telegram_notification_settings','telegram_kol_notification_settings',
  'telegram_trade_events','telegram_notification_outbox','telegram_notification_items','telegram_notification_updates',
  'telegram_notification_pacing','journal_wallets'] as const;
export const freshCutoverDeliveryTables=['telegram_notification_settings','telegram_kol_notification_settings','telegram_trade_events',
  'telegram_notification_outbox','telegram_notification_items','telegram_notification_updates','telegram_notification_pacing'] as const;
type Table=typeof freshCutoverTables[number];type Row=Record<string,any>;type Binding={database:string;host:string;port:number};
type Column={name:string;type:string};type FileRecord={file:string;bytes:number;rows:number;sha256:string;columns:Column[]};
export type CutoverBoundary=FreshPriceBlock&{parentHash:string;selectedAt:string;confirmations:6};
export interface FreshCutoverManifest {
  version:1;kind:'kollens_fresh_v14_cutover';phase:'initial'|'seal';id:string;createdAt:string;operatorSha256:string;
  source:Binding;destination:Binding;sourceReadOnly:true;sourceSnapshot:string;boundary:CutoverBoundary|null;
  parentManifestSha256:string|null;tables:Record<Table,FileRecord>;kols:FileRecord;sourceIdentityDigest:string;sourceDeliveryDigest:string;
  legacyPendingCount:number;legacyLeasedCount:number;legacyBotSendingCount:number;legacyUnprocessedCount:number;legacyBacklog:{policy:'legacy_alert_policy_v1';evaluatedAt:string;maxAgeMs:300000;total:number;silent:number;reasons:Record<string,number>;sha256:string}|null;legacyHandoff:{blockNumber:string;blockHash:string}|null;financialRowsExported:0;
}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>hash(JSON.stringify(value));
function need(ok:unknown,reason:string):asserts ok{if(!ok)throw Error(reason);}
const identifier=(v:string)=>{need(/^[a-z_][a-z_0-9]*$/.test(v),'cutover_identifier_invalid');return '"'+v+'"';};
const noFinance=['financial_events','scope_event_results','positions','open_lots','tokens','markets','launch_facts','recent_evidence'];
const kolColumns=['address','display_name','avatar_url','twitter','source','is_tracked','first_seen_at','last_seen_at','profile_checked_at','avatar_checked_at'];

export function freshCutoverBindings(source:string,destination:string,mode='production') {
  const bind=(text:string):Binding=>{const u=new URL(text);need(['postgres:','postgresql:'].includes(u.protocol),'cutover_database_url_invalid');
    need(['127.0.0.1','localhost','[::1]'].includes(u.hostname),'cutover_loopback_required');need(!u.search&&!u.hash,'cutover_database_url_options_forbidden');
    const database=decodeURIComponent(u.pathname.slice(1));need(/^[a-z][a-z0-9_]{2,62}$/.test(database),'cutover_database_name_invalid');return{database,host:u.hostname,port:Number(u.port||5432)};};
  const from=bind(source),to=bind(destination);need(mode==='production'||mode==='rehearsal','cutover_mode_invalid');
  if(mode==='production'){need(from.database==='bscan'&&from.port===5434,'cutover_source_binding_invalid');need(to.database==='kollens_fresh_v14'&&to.port===5437,'cutover_destination_binding_invalid');}
  else{need(from.port===5436&&to.port===5436&&/^kollens_cutover_source_test_[a-z0-9_]+$/.test(from.database)&&/^kollens_cutover_dest_test_[a-z0-9_]+$/.test(to.database),'cutover_rehearsal_binding_invalid');}
  need(from.database!==to.database,'cutover_source_equals_destination');return{source:from,destination:to};
}
async function binding(client:PoolClient,expected:Binding){const row=(await client.query('SELECT current_database() AS database')).rows[0];need(row.database===expected.database,'cutover_actual_database_mismatch');}
async function readOnly(client:PoolClient){await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL timezone='UTC'");
  need((await client.query("SELECT current_setting('transaction_read_only') value")).rows[0].value==='on','cutover_source_not_read_only');}
async function columns(client:PoolClient,table:string):Promise<Column[]>{return(await client.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[table])).rows;}
async function primaryKeys(client:PoolClient,table:Table):Promise<string[]>{const rows=(await client.query(`SELECT a.attname AS name FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace JOIN unnest(i.indkey) WITH ORDINALITY k(attnum,ord) ON true
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum WHERE n.nspname='public' AND c.relname=$1 AND i.indisprimary ORDER BY k.ord`,[table])).rows;
  need(rows.length>0,'cutover_table_without_primary_key');return rows.map(r=>r.name);}
async function destinationGuard(client:PoolClient){need(!(await client.query("SELECT to_regclass('public.position_snapshots') AS legacy")).rows[0].legacy,'cutover_legacy_destination_forbidden');
  const legacy=(await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('trades','tokens','kols','worker_state') AND c.relkind IN('r','p') LIMIT 1")).rowCount;need(!legacy,'cutover_legacy_destination_forbidden');}
async function rowsDigest(client:PoolClient,table:Table){const rows=(await client.query(`SELECT to_jsonb(t)::text body FROM public.${identifier(table)} t ORDER BY body`)).rows;const h=createHash('sha256');for(const r of rows)h.update(r.body+'\n');return{rows:rows.length,sha256:h.digest('hex')};}
async function checkEmpty(client:PoolClient){for(const name of noFinance){const table=(await client.query('SELECT to_regclass($1) AS name',['fresh.'+name])).rows[0].name;
  if(table)need(!(await client.query(`SELECT 1 FROM fresh.${identifier(name)} LIMIT 1`)).rowCount,'cutover_financial_destination_not_empty');}
  for(const name of freshCutoverTables){const table=(await client.query('SELECT to_regclass($1) AS name',['public.'+name])).rows[0].name;if(table)need(!(await client.query(`SELECT 1 FROM public.${identifier(name)} LIMIT 1`)).rowCount,'cutover_feature_destination_not_empty');}}
async function deliveryCounts(client:PoolClient){return(await client.query(`SELECT count(*) FILTER(WHERE status='pending')::int AS pending,
  count(*) FILTER(WHERE status='leased')::int AS leased FROM public.telegram_notification_outbox`)).rows[0];}
async function legacyNotificationBacklog(client:PoolClient,handoff:string,at:string){
  // Match the legacy sender's five-minute age, public-token and consent gates.
  // Retain a digest of every untouched silent row instead of changing old flags.
  const cursor='cutover_'+randomUUID().replaceAll('-',''),cutoff=new Date(Date.parse(at)-300000).toISOString(),reasons:Record<string,number>={},h=createHash('sha256');let total=0,blocked=0;
  await client.query(`DECLARE ${identifier(cursor)} NO SCROLL CURSOR FOR SELECT t.id::text,CASE
    WHEN t.timestamp<$1::timestamptz THEN 'expired'
    WHEN k.address IS NULL OR NOT k.is_tracked THEN 'not_public_tracked'
    WHEN t.side NOT IN('buy','sell') THEN 'non_trade'
    WHEN v.address IS NULL THEN 'missing_token_identity'
    WHEN NOT ${kolProfileTokenSql('v')} THEN 'excluded_token'
    WHEN t.block_hash IS NULL THEN 'block_hash_unknown'
    WHEN t.timestamp>$2::timestamptz THEN 'future_timestamp'
    WHEN NOT EXISTS(SELECT 1 FROM telegram_notification_settings s
      JOIN account_watch_entries f ON f.user_id=s.user_id AND f.kind='kol' AND f.address=t.wallet_address
      LEFT JOIN telegram_kol_notification_settings m ON m.user_id=s.user_id AND m.wallet_address=f.address
      WHERE s.enabled AND s.connection='connected' AND s.chat_id IS NOT NULL AND NOT COALESCE(m.muted,false)
      AND t.timestamp>GREATEST(s.enabled_since,f.added_at,COALESCE(m.resumed_since,s.enabled_since))
      AND ((t.side='buy' AND s.buys) OR (t.side='sell' AND s.sells))) THEN 'no_eligible_recipient'
    ELSE 'deliverable' END reason FROM public.trades t LEFT JOIN public.published_kols k ON k.address=t.wallet_address
    LEFT JOIN public.tokens v ON v.address=t.token_address WHERE t.observed_live AND NOT t.telegram_notification_processed
    AND t.block_number<=$3::bigint ORDER BY t.id`,[cutoff,at,handoff]);
  for(;;){const page=(await client.query(`FETCH FORWARD 500 FROM ${identifier(cursor)}`)).rows;if(!page.length)break;for(const row of page){total++;reasons[row.reason]=(reasons[row.reason]??0)+1;h.update(JSON.stringify([row.id,row.reason])+'\n');if(['deliverable','missing_token_identity','block_hash_unknown','future_timestamp'].includes(row.reason))blocked++;}}
  await client.query(`CLOSE ${identifier(cursor)}`);return{blocked,evidence:{policy:'legacy_alert_policy_v1' as const,evaluatedAt:at,maxAgeMs:300000 as const,total,silent:total-blocked,reasons,sha256:h.digest('hex')}};
}
async function writeRows(client:PoolClient,folder:string,file:string,select:string,cols:Column[]):Promise<FileRecord>{
  const filename=path.join(folder,file),handle=await open(filename,'wx',0o600),h=createHash('sha256');let bytes=0,count=0;const cursor='cutover_'+randomUUID().replaceAll('-','');
  try{await client.query(`DECLARE ${identifier(cursor)} NO SCROLL CURSOR FOR ${select}`);for(;;){const page=(await client.query(`FETCH FORWARD 500 FROM ${identifier(cursor)}`)).rows;if(!page.length)break;
    for(const row of page){const line=row.body+'\n';bytes+=Buffer.byteLength(line);need(bytes<=256*1024*1024,'cutover_table_export_size_limit');need(Buffer.byteLength(line)<=8*1024*1024,'cutover_row_export_size_limit');h.update(line);await handle.writeFile(line);count++;}}
    await client.query(`CLOSE ${identifier(cursor)}`);await handle.sync();return{file,bytes,rows:count,sha256:h.digest('hex'),columns:cols};
  }finally{await handle.close();}}
async function fileRows(folder:string,record:FileRecord,work:(raw:string,row:Row)=>Promise<void>){
  need(/^[a-z_]+\.ndjson$/.test(record.file),'cutover_artifact_path_invalid');const filename=path.join(folder,record.file),size=await stat(filename);need(size.isFile()&&size.size===record.bytes&&size.size<=256*1024*1024,'cutover_artifact_size_changed');
  const h=createHash('sha256');let count=0;const lines=createInterface({input:createReadStream(filename),crlfDelay:Infinity});
  for await(const raw of lines){need(Buffer.byteLength(raw)<=8*1024*1024,'cutover_artifact_row_oversize');const row=JSON.parse(raw);need(row&&typeof row==='object'&&!Array.isArray(row),'cutover_artifact_row_invalid');
    need(digest(Object.keys(row).sort())===digest(record.columns.map(c=>c.name).sort()),'cutover_artifact_columns_changed');h.update(raw+'\n');await work(raw,row);count++;}
  need(count===record.rows&&h.digest('hex')===record.sha256,'cutover_artifact_checksum_changed');}
export async function selectFreshCutoverBoundary(rpc:Rpc):Promise<CutoverBoundary>{const confirmed=await freshConfirmedPriceBlock(rpc),header=await rpc<any>('eth_getBlockByNumber',['0x'+confirmed.number.toString(16),false]);
  need(header?.hash===confirmed.hash&&/^0x[\da-f]{64}$/.test(header.parentHash),'cutover_boundary_header_invalid');return{...confirmed,parentHash:header.parentHash,selectedAt:new Date().toISOString(),confirmations:6};}
async function verifyBoundary(rpc:Rpc,b:CutoverBoundary,maxAge:boolean){need(b&&Number.isSafeInteger(b.number)&&b.number>0&&/^0x[\da-f]{64}$/.test(b.hash)&&/^0x[\da-f]{64}$/.test(b.parentHash)&&b.confirmations===6,'cutover_boundary_invalid');
  need(Number.isFinite(Date.parse(b.timestamp))&&Number.isFinite(Date.parse(b.selectedAt)),'cutover_boundary_time_invalid');
  if(maxAge)need(Date.now()-Date.parse(b.selectedAt)>=0&&Date.now()-Date.parse(b.selectedAt)<=300000,'cutover_boundary_plan_expired');
  const [chain,head,header]=await Promise.all([rpc<string>('eth_chainId',[]),rpc<string>('eth_blockNumber',[]),rpc<any>('eth_getBlockByNumber',['0x'+b.number.toString(16),false])]);
  need(chain==='0x38'&&BigInt(head)>=BigInt(b.number)+6n&&header?.hash===b.hash&&header.parentHash===b.parentHash&&new Date(Number(BigInt(header.timestamp))*1000).toISOString()===b.timestamp,'cutover_boundary_noncanonical');}

export async function planFreshCutover(options:{source:Pool;destination:Pool;bindings:{source:Binding;destination:Binding};folder:string;operatorSha256:string;phase?:'initial'|'seal';boundary?:CutoverBoundary|null}){
  need(/^[\da-f]{64}$/.test(options.operatorSha256),'cutover_operator_hash_invalid');await mkdir(options.folder,{recursive:false,mode:0o700});
  const src=await options.source.connect(),dest=await options.destination.connect();
  try{await readOnly(src);await readOnly(dest);await binding(src,options.bindings.source);await binding(dest,options.bindings.destination);await destinationGuard(dest);
    const phase=options.phase??'initial',prior=(await dest.query("SELECT to_regclass('fresh.checkpoints') AS name")).rows[0].name? (await dest.query("SELECT value FROM fresh.checkpoints WHERE key='production_cutover_import'")).rows[0]?.value:null;
    if(phase==='initial'){need(!prior,'cutover_already_initialized_use_seal');await checkEmpty(dest);}else need(prior?.version===1,'cutover_initial_import_required');
    const manifest:FreshCutoverManifest={version:1,kind:'kollens_fresh_v14_cutover',phase,id:randomUUID(),createdAt:new Date().toISOString(),operatorSha256:options.operatorSha256,
      ...options.bindings,sourceReadOnly:true,sourceSnapshot:(await src.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot,boundary:phase==='seal'?prior.boundary:options.boundary??null,
      parentManifestSha256:phase==='seal'?prior.manifestSha256:null,tables:{} as any,kols:null as any,sourceIdentityDigest:'',sourceDeliveryDigest:'',legacyPendingCount:0,legacyLeasedCount:0,legacyBotSendingCount:0,legacyUnprocessedCount:0,legacyBacklog:null,legacyHandoff:null,financialRowsExported:0};
    for(const table of freshCutoverTables){const cols=await columns(src,table);need(cols.length>0,'cutover_source_table_missing:'+table);
      manifest.tables[table]=await writeRows(src,options.folder,table+'.ndjson',`SELECT to_jsonb(t)::text body FROM public.${identifier(table)} t ORDER BY body`,cols);}
    const actualKolCols=await columns(src,'kols');need(kolColumns.every(n=>actualKolCols.some(c=>c.name===n)),'cutover_source_kol_schema_changed');
    manifest.kols=await writeRows(src,options.folder,'kols.ndjson',`SELECT to_jsonb(t)::text body FROM(SELECT ${kolColumns.map(identifier).join(',')} FROM public.kols)t ORDER BY body`,actualKolCols.filter(c=>kolColumns.includes(c.name)));
    manifest.sourceIdentityDigest=digest(freshCutoverTables.map(t=>[t,manifest.tables[t].sha256,manifest.tables[t].rows]));
    manifest.sourceDeliveryDigest=digest(freshCutoverDeliveryTables.map(t=>[t,manifest.tables[t].sha256,manifest.tables[t].rows]));const counts=await deliveryCounts(src);manifest.legacyPendingCount=counts.pending;manifest.legacyLeasedCount=counts.leased;
    manifest.legacyBotSendingCount=(await src.query("SELECT count(*)::int n FROM public.auth_bot_login_attempts WHERE delivery_status='sending' OR delivery_lease_until IS NOT NULL")).rows[0].n;
    if(phase==='seal'){const node=(await src.query("SELECT value FROM public.worker_state WHERE key='node'")).rows[0]?.value;
      need(node&&/^(0|[1-9][0-9]{0,15})$/.test(String(node.blockNumber))&&/^0x[\da-f]{64}$/.test(node.blockHash),'cutover_legacy_handoff_checkpoint_missing');
      manifest.legacyHandoff={blockNumber:String(node.blockNumber),blockHash:node.blockHash};const backlog=await legacyNotificationBacklog(src,String(node.blockNumber),manifest.createdAt);manifest.legacyUnprocessedCount=backlog.blocked;manifest.legacyBacklog=backlog.evidence;}
    await src.query('COMMIT');await dest.query('COMMIT');const bytes=JSON.stringify(manifest,null,2),handle=await open(path.join(options.folder,'manifest.json'),'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    return{manifest,sha256:hash(bytes),folder:options.folder,dryRun:true,applyReady:!!manifest.boundary&&phase==='initial'};
  }catch(e){await src.query('ROLLBACK');await dest.query('ROLLBACK');throw e;}finally{src.release();dest.release();}}

export async function readFreshCutoverManifest(filename:string,expectedSha:string,operatorSha:string){const bytes=await readFile(filename);need(bytes.length<=1024*1024&&hash(bytes)===expectedSha,'cutover_manifest_checksum_invalid');
  const m=JSON.parse(bytes.toString()) as FreshCutoverManifest;need(m.version===1&&m.kind==='kollens_fresh_v14_cutover'&&m.sourceReadOnly===true&&m.financialRowsExported===0&&m.operatorSha256===operatorSha,'cutover_manifest_identity_invalid');
  need(['initial','seal'].includes(m.phase)&&digest(Object.keys(m.tables).sort())===digest([...freshCutoverTables].sort()),'cutover_manifest_table_whitelist_invalid');
  need(m.sourceIdentityDigest===digest(freshCutoverTables.map(t=>[t,m.tables[t].sha256,m.tables[t].rows]))&&m.sourceDeliveryDigest===digest(freshCutoverDeliveryTables.map(t=>[t,m.tables[t].sha256,m.tables[t].rows])),'cutover_manifest_digest_invalid');
  const folder=path.dirname(path.resolve(filename));for(const table of freshCutoverTables)await fileRows(folder,m.tables[table],async()=>{});await fileRows(folder,m.kols,async()=>{});return{manifest:m,folder};}
async function compatible(client:PoolClient,m:FreshCutoverManifest){const ordered=(v:Column[])=>[...v].sort((a,b)=>a.name.localeCompare(b.name));for(const table of freshCutoverTables)need(digest(ordered(await columns(client,table)))===digest(ordered(m.tables[table].columns)),'cutover_feature_schema_drift:'+table);}
async function rawInserter(client:PoolClient,table:Table,upsert=false){const cols=await columns(client,table),names=cols.map(c=>c.name),keys=await primaryKeys(client,table);let conflict='';
  if(upsert){const updates=names.filter(n=>!keys.includes(n)).map(n=>`${identifier(n)}=EXCLUDED.${identifier(n)}`);conflict=` ON CONFLICT(${keys.map(identifier).join(',')}) ${updates.length?'DO UPDATE SET '+updates.join(','):'DO NOTHING'}`;}
  return async(raw:string[])=>{if(raw.length)await client.query(`INSERT INTO public.${identifier(table)}(${names.map(identifier).join(',')}) SELECT ${names.map(identifier).join(',')} FROM json_populate_recordset(NULL::public.${identifier(table)},$1::json)${conflict}`,['['+raw.join(',')+']']);};}
async function importTable(client:PoolClient,table:Table,folder:string,record:FileRecord,upsert=false){const insert=await rawInserter(client,table,upsert);if(table==='telegram_notification_outbox'){
    const rows:{raw:string;row:Row}[]=[];await fileRows(folder,record,async(raw,row)=>{rows.push({raw,row});});const ordered=orderFreshCutoverOutbox(rows);for(let i=0;i<ordered.length;i+=200)await insert(ordered.slice(i,i+200).map(v=>v.raw));return;}
  let batch:string[]=[],bytes=0;await fileRows(folder,record,async raw=>{if(batch.length>=200||bytes+Buffer.byteLength(raw)>1024*1024){await insert(batch);batch=[];bytes=0;}batch.push(raw);bytes+=Buffer.byteLength(raw);});await insert(batch);}
async function verifySourceSubset(client:PoolClient,table:Table,folder:string,record:FileRecord){const keys=await primaryKeys(client,table),check=async(raw:string[])=>{if(!raw.length)return;const r=await client.query(`WITH expected AS(SELECT * FROM json_populate_recordset(NULL::public.${identifier(table)},$1::json))
  SELECT count(*)::int n FROM expected e LEFT JOIN public.${identifier(table)} t ON ${keys.map(k=>`e.${identifier(k)} IS NOT DISTINCT FROM t.${identifier(k)}`).join(' AND ')} WHERE to_jsonb(e) IS DISTINCT FROM to_jsonb(t)`,['['+raw.join(',')+']']);need(r.rows[0].n===0,'cutover_sealed_source_row_mismatch:'+table);};let batch:string[]=[],bytes=0;
  await fileRows(folder,record,async raw=>{if(batch.length>=200||bytes+Buffer.byteLength(raw)>1024*1024){await check(batch);batch=[];bytes=0;}batch.push(raw);bytes+=Buffer.byteLength(raw);});await check(batch);}
export function orderFreshCutoverOutbox(rows:{raw:string;row:Row}[]){const pending=new Map(rows.map(v=>[v.row.id,v])),ordered:typeof rows=[];need(pending.size===rows.length,'cutover_duplicate_outbox_id');
  while(pending.size){let advanced=false;for(const [id,v] of pending){if(v.row.correction_of!=null&&pending.has(v.row.correction_of))continue;need(v.row.correction_of==null||rows.some(r=>r.row.id===v.row.correction_of),'cutover_outbox_parent_missing');ordered.push(v);pending.delete(id);advanced=true;}need(advanced,'cutover_outbox_correction_cycle');}return ordered;}
async function kolsAndMemberships(client:PoolClient,m:FreshCutoverManifest,folder:string){const boundary=m.boundary!;const members:{raw:string;row:Row}[]=[];await fileRows(folder,m.tables.journal_wallets,async(raw,row)=>{need(typeof row.user_id==='string'&&/^0x[\da-f]{40}$/.test(row.wallet_address),'cutover_membership_identity_invalid');members.push({raw,row});});
  const memberWallets=new Set(members.map(x=>x.row.wallet_address));await fileRows(folder,m.kols,async(_raw,row)=>{need(/^0x[\da-f]{40}$/.test(row.address)&&typeof row.is_tracked==='boolean','cutover_kol_identity_invalid');
    await client.query('INSERT INTO fresh.wallets(address,active,monitoring_from_block,registered_at) VALUES($1,$2,$3,$4)',[row.address,row.is_tracked||memberWallets.has(row.address),boundary.number+1,boundary.timestamp]);
    const names=kolColumns.filter(n=>n!=='address');await client.query(`INSERT INTO fresh.kols(wallet_address,${names.map(identifier).join(',')}) VALUES(${['$1',...names.map((_,i)=>'$'+(i+2))].join(',')})`,[row.address,...names.map(n=>row[n])]);
    if(row.is_tracked)await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',ARRAY[$2]::text[],$3,$4)",['kol:'+row.address,row.address,boundary.timestamp,boundary.number+1]);});
  for(const {row} of members)await client.query(`INSERT INTO fresh.wallets(address,monitoring_from_block,registered_at) VALUES($1,$2,$3) ON CONFLICT(address) DO UPDATE SET active=true`,[row.wallet_address,boundary.number+1,boundary.timestamp]);return members;}
async function insertMemberships(client:PoolClient,m:FreshCutoverManifest,members:{raw:string;row:Row}[]){const b=m.boundary!,mappings=[];for(const {row} of members){need(Number.isFinite(Date.parse(row.activity_from))&&Number.isFinite(Date.parse(row.added_at)),'cutover_membership_time_invalid');
  // PostgreSQL compares the original timestamps at microsecond precision.
  // JavaScript milliseconds would clamp boundary+1us back to the boundary.
  const effective:string=(await client.query('SELECT GREATEST($1::timestamptz,$2::timestamptz)::text effective',[row.activity_from,b.timestamp])).rows[0].effective;
  await client.query(`INSERT INTO public.journal_wallets(user_id,wallet_address,label,added_at,activity_from,revision,registration_block,registration_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.user_id,row.wallet_address,row.label,row.added_at,effective,row.revision,b.number+1,b.hash]);
  await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,account_id,starts_at,starts_block) VALUES($1,'portfolio_wallet',$2,$3,$4,$5)",[freshPortfolioScope(row.user_id,row.wallet_address),[row.wallet_address],row.user_id,effective,b.number+1]);
  mappings.push({userId:row.user_id,wallet:row.wallet_address,originalActivityFrom:row.activity_from,effectiveActivityFrom:effective,originalRegistrationBlock:row.registration_block??null,effectiveRegistrationBlock:b.number+1});}
  for(const user of new Set(members.map(v=>v.row.user_id))){const own=members.filter(v=>v.row.user_id===user);
    await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,account_id,starts_at,starts_block) VALUES($1,'portfolio_combined',$2,$3::text,(SELECT min(activity_from) FROM public.journal_wallets WHERE user_id=$3::uuid),$4)",[freshPortfolioScope(user),own.map(v=>v.row.wallet_address).sort(),user,b.number+1]);}return mappings;}

export async function applyFreshCutover(options:{destination:Pool;manifest:FreshCutoverManifest;folder:string;manifestSha256:string;rpc:Rpc;apply:boolean;sourceWritersPaused:boolean}){
  const {manifest:m,destination,apply}=options;need(m.phase==='initial','cutover_initial_manifest_required');need(m.boundary,'cutover_boundary_selection_required');need(options.sourceWritersPaused,'cutover_source_writers_pause_ack_required');
  const check=await destination.connect();try{await readOnly(check);await binding(check,m.destination);await destinationGuard(check);
    const exists=(await check.query("SELECT to_regclass('fresh.checkpoints') AS name")).rows[0].name,prior=exists?(await check.query("SELECT value FROM fresh.checkpoints WHERE key='production_cutover_import'")).rows[0]?.value:null;
    if(prior){need(prior.manifestSha256===options.manifestSha256,'cutover_destination_has_other_import');return{alreadyApplied:true,committed:false,manifestSha256:options.manifestSha256};}await checkEmpty(check);await check.query('COMMIT');
  }finally{await check.query('ROLLBACK');check.release();}await verifyBoundary(options.rpc,m.boundary,true);if(!apply)return{dryRun:true,committed:false,boundary:m.boundary,sourceReadOnly:true,financialRowsImported:0};
  await ensureFreshSchema(destination);const client=await destination.connect();try{await client.query('BEGIN');await client.query("SET LOCAL timezone='UTC'");await client.query('SELECT pg_advisory_xact_lock(73621940)');await client.query('SELECT pg_advisory_xact_lock(73621941)');await destinationGuard(client);await checkEmpty(client);await compatible(client,m);
    need(!(await client.query("SELECT 1 FROM fresh.checkpoints WHERE key='start'")).rowCount,'cutover_boundary_already_initialized');const b=m.boundary,value={startBlock:b.number,startHash:b.hash,startTime:b.timestamp,confirmations:6};
    for(const key of ['start','capture','decode'])await client.query('INSERT INTO fresh.checkpoints(key,block_number,block_hash,value) VALUES($1,$2,$3,$4::jsonb)',[key,b.number,b.hash,JSON.stringify(value)]);
    await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[b.number,b.hash,b.parentHash,b.timestamp]);const members=await kolsAndMemberships(client,m,options.folder);
    for(const table of freshCutoverTables)if(table!=='journal_wallets')await importTable(client,table,options.folder,m.tables[table]);
    const mappings=await insertMemberships(client,m,members),destinationDigests:Record<string,unknown>={};for(const table of freshCutoverTables){const got=await rowsDigest(client,table);destinationDigests[table]=got;if(table!=='journal_wallets')need(got.rows===m.tables[table].rows&&got.sha256===m.tables[table].sha256,'cutover_import_digest_mismatch:'+table);}
    const report={version:1,manifestSha256:options.manifestSha256,sourceIdentityDigest:m.sourceIdentityDigest,boundary:b,destinationDigests,
      sourceTableDigests:Object.fromEntries(freshCutoverTables.map(t=>[t,{rows:m.tables[t].rows,sha256:m.tables[t].sha256}])),
      sourceKolsSha256:m.kols.sha256,membershipMappingsDigest:digest(mappings),membershipMappings:mappings,importedAt:new Date().toISOString(),financialRowsImported:0};
    await client.query("INSERT INTO fresh.checkpoints(key,value) VALUES('production_cutover_import',$1::jsonb)",[JSON.stringify(report)]);await client.query('COMMIT');return{committed:true,manifestSha256:options.manifestSha256,featureTables:freshCutoverTables.length,memberships:members.length,financialRowsImported:0};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}

export async function sealFreshCutover(options:{destination:Pool;manifest:FreshCutoverManifest;folder:string;manifestSha256:string;apply:boolean;legacySenderStopped:boolean;legacyCollectorStopped:boolean;sourceWritersPaused:boolean}){
  const {manifest:m}=options;need(m.phase==='seal'&&m.parentManifestSha256,'cutover_seal_manifest_required');need(options.legacySenderStopped&&options.legacyCollectorStopped&&options.sourceWritersPaused,'cutover_legacy_stop_ack_required');need(m.legacyPendingCount===0&&m.legacyLeasedCount===0&&m.legacyUnprocessedCount===0,'cutover_legacy_outbox_not_drained');need(m.legacyBotSendingCount===0,'cutover_legacy_bot_login_not_drained');need(m.legacyHandoff,'cutover_legacy_handoff_checkpoint_missing');need(m.legacyBacklog?.policy==='legacy_alert_policy_v1'&&m.legacyBacklog.maxAgeMs===300000&&m.legacyBacklog.total===m.legacyBacklog.silent,'cutover_legacy_backlog_evidence_required');
  const client=await options.destination.connect();try{await client.query(options.apply?'BEGIN': 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL timezone='UTC'");await binding(client,m.destination);await destinationGuard(client);
    if(options.apply){await client.query('SELECT pg_advisory_xact_lock(73621940)');await client.query('SELECT pg_advisory_xact_lock(73621941)');for(const table of freshCutoverTables)await client.query(`LOCK TABLE public.${identifier(table)} IN SHARE ROW EXCLUSIVE MODE`);}
    const imported=(await client.query("SELECT value FROM fresh.checkpoints WHERE key='production_cutover_import'")).rows[0]?.value;need(imported?.manifestSha256===m.parentManifestSha256,'cutover_initial_manifest_changed');
    need(BigInt(m.legacyHandoff.blockNumber)>=BigInt(imported.boundary.number),'cutover_legacy_handoff_before_fresh_boundary');
    const anchor=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[m.legacyHandoff.blockNumber])).rows[0];need(anchor?.block_hash===m.legacyHandoff.blockHash,'cutover_handoff_not_yet_captured');
    const sealed=(await client.query("SELECT value FROM fresh.checkpoints WHERE key='production_cutover_seal'")).rows[0]?.value;if(sealed){need(sealed.sourceManifestSha256===options.manifestSha256,'cutover_other_seal_exists');await client.query('ROLLBACK');return{alreadySealed:true,committed:false};}
    await compatible(client,m);for(const table of freshCutoverTables){const current=await rowsDigest(client,table);need(digest(current)===digest(imported.destinationDigests[table]),'cutover_destination_feature_changed:'+table);
      if(!freshCutoverDeliveryTables.includes(table as any))need(digest({rows:m.tables[table].rows,sha256:m.tables[table].sha256})===digest(imported.sourceTableDigests?.[table]),'cutover_source_identity_changed:'+table);}
    // Financial capture may update Fresh last_seen_at. Refresh only general KOL
    // identity, while the tracked role/address set must remain exactly fixed.
    const targetRoles=(await client.query('SELECT wallet_address AS address,is_tracked FROM fresh.kols ORDER BY wallet_address')).rows,incomingRoles:Row[]=[];
    await fileRows(options.folder,m.kols,async(_raw,row)=>{incomingRoles.push({address:row.address,is_tracked:row.is_tracked});});incomingRoles.sort((a,b)=>a.address.localeCompare(b.address));
    need(digest(incomingRoles)===digest(targetRoles),'cutover_source_monitoring_roles_changed');
    if(!options.apply){await client.query('ROLLBACK');return{dryRun:true,committed:false,sourceDeliveryDigest:m.sourceDeliveryDigest,legacyPendingCount:0,legacyLeasedCount:0};}
    await fileRows(options.folder,m.kols,async(_raw,row)=>{await client.query('UPDATE fresh.kols SET display_name=$2,avatar_url=$3,twitter=$4,source=$5,profile_checked_at=$6,avatar_checked_at=$7 WHERE wallet_address=$1',[row.address,row.display_name,row.avatar_url,row.twitter,row.source,row.profile_checked_at,row.avatar_checked_at]);});
    for(const table of freshCutoverDeliveryTables)await importTable(client,table,options.folder,m.tables[table],true);
    const destinationDeliveryDigests:Record<string,unknown>={},retainedDestinationOnlyRows:Record<string,number>={};for(const table of freshCutoverDeliveryTables){await verifySourceSubset(client,table,options.folder,m.tables[table]);const current=await rowsDigest(client,table);destinationDeliveryDigests[table]=current;retainedDestinationOnlyRows[table]=current.rows-m.tables[table].rows;}
    const value={version:1,sourceManifestSha256:options.manifestSha256,parentManifestSha256:m.parentManifestSha256,sealedAt:new Date().toISOString(),sourceDeliveryDigest:m.sourceDeliveryDigest,legacyPendingCount:0,legacyLeasedCount:0,legacyUnprocessedCount:0,legacySenderStoppedAcknowledged:true,
      legacyCollectorStoppedAcknowledged:true,legacyBotSendingCount:0,legacyBacklog:m.legacyBacklog,legacyHandoffBlock:m.legacyHandoff.blockNumber,legacyHandoffHash:m.legacyHandoff.blockHash,destinationDeliveryDigests,retainedDestinationOnlyRows};
    await client.query("INSERT INTO fresh.checkpoints(key,value) VALUES('production_cutover_seal',$1::jsonb)",[JSON.stringify(value)]);await client.query('COMMIT');return{committed:true,...value};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}

export async function activateFreshCutover(options:{destination:Pool;destinationBinding:Binding;rpc:Rpc;manifestSha256:string;apply:boolean;sourceWritersPaused:boolean;legacySenderStopped:boolean;legacyCollectorStopped:boolean}){
  need(options.sourceWritersPaused&&options.legacySenderStopped&&options.legacyCollectorStopped,'cutover_activation_stop_ack_required');const client=await options.destination.connect();
  try{await client.query(options.apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');if(options.apply){await client.query('SELECT pg_advisory_xact_lock(73621940)');await client.query('SELECT pg_advisory_xact_lock(73621941)');}
    await binding(client,options.destinationBinding);await destinationGuard(client);const prior=(await client.query("SELECT value FROM fresh.checkpoints WHERE key='production_activation'")).rows[0]?.value;if(prior){need(prior.sourceManifestSha256===options.manifestSha256,'cutover_other_activation_exists');need(!prior.invalidatedAt,'cutover_existing_activation_invalidated');await client.query('ROLLBACK');return{alreadyActivated:true,committed:false};}
    const seal=(await client.query("SELECT value FROM fresh.checkpoints WHERE key='production_cutover_seal'")).rows[0]?.value;need(seal?.version===1&&seal.sourceManifestSha256===options.manifestSha256&&seal.legacyPendingCount===0&&seal.legacyLeasedCount===0&&seal.legacySenderStoppedAcknowledged===true,'cutover_final_seal_required');
    need(/^(0|[1-9][0-9]{0,15})$/.test(String(seal.legacyHandoffBlock))&&/^0x[\da-f]{64}$/.test(seal.legacyHandoffHash)&&seal.legacyUnprocessedCount===0&&seal.legacyBotSendingCount===0&&seal.legacyCollectorStoppedAcknowledged===true,'cutover_sealed_handoff_required');
    const capture=(await client.query(`SELECT c.block_number::text,c.block_hash,c.revision::text,b.parent_hash,b.occurred_at FROM fresh.checkpoints c JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE c.key='capture' ${options.apply?'FOR UPDATE OF c FOR SHARE OF b':''}`)).rows[0];
    need(capture&&Date.now()-Date.parse(capture.occurred_at)>=0&&Date.now()-Date.parse(capture.occurred_at)<=30000,'cutover_fresh_capture_required');
    const b:CutoverBoundary={number:Number(capture.block_number),hash:capture.block_hash,parentHash:capture.parent_hash,timestamp:new Date(capture.occurred_at).toISOString(),selectedAt:new Date().toISOString(),confirmations:6};await verifyBoundary(options.rpc,b,false);
    need(BigInt(capture.block_number)>=BigInt(seal.legacyHandoffBlock),'cutover_fresh_capture_behind_handoff');const handoff=(await client.query('SELECT block_number::text,block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1',[seal.legacyHandoffBlock])).rows[0];need(handoff?.block_hash===seal.legacyHandoffHash,'cutover_sealed_handoff_noncanonical');
    const continuity=(await client.query(`WITH headers AS(SELECT block_number,parent_hash,lag(block_hash) OVER(ORDER BY block_number) previous_hash FROM fresh.recent_blocks WHERE block_number BETWEEN $1 AND $2)
      SELECT count(*)::text n,count(*) FILTER(WHERE previous_hash IS NOT NULL AND parent_hash<>previous_hash)::int invalid FROM headers`,[handoff.block_number,capture.block_number])).rows[0];
    need(BigInt(continuity.n)===BigInt(capture.block_number)-BigInt(handoff.block_number)+1n&&continuity.invalid===0,'cutover_handoff_capture_continuity_failed');
    await verifyBoundary(options.rpc,{number:Number(handoff.block_number),hash:handoff.block_hash,parentHash:handoff.parent_hash,timestamp:new Date(handoff.occurred_at).toISOString(),selectedAt:new Date().toISOString(),confirmations:6},false);
    const value={version:1,activatedAt:new Date().toISOString(),alertStartBlock:handoff.block_number,alertStartHash:handoff.block_hash,sourceManifestSha256:options.manifestSha256,captureRevision:capture.revision};
    if(options.apply)await client.query("INSERT INTO fresh.checkpoints(key,block_number,block_hash,value) VALUES('production_activation',$1,$2,$3::jsonb)",[handoff.block_number,handoff.block_hash,JSON.stringify(value)]);
    await client.query(options.apply?'COMMIT':'ROLLBACK');return{committed:options.apply,dryRun:!options.apply,...value,telegramMessagesSent:0};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
