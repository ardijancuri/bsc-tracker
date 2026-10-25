import {createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import type {Rpc} from '../rpc.js';
import {WBNB} from '../launchpad.js';
import {decodeFreshEvidence,encodeFreshEvidence,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock} from './capture.js';
import {freshEventFromRow,validateFreshFinancialEvent,type FreshFinancialEvent} from './accounting.js';
import {normalizeFreshReceipt,persistFreshDecodedReceipt,type FreshDecodedReceipt,FRESH_DECODER_VERSION} from './decode.js';
import {reconcileFreshGangHistory,type FreshGangHistoryActivity,type FreshGangHistoryProvenance} from './gangHistoryImport.js';
import {recoverFreshGangTradeMarketMark} from './gangTradeMarketMark.js';
import {persistFreshGangTradeMarketMark} from './gangTradeMarketMark.js';
import {persistFreshTradeBnbPrice} from './tradeBnbDisplay.js';
import {removeFreshResolvedPendingTrades} from './pendingTrades.js';
import {freshQuoteUsd,freshTokenMetadata,type FreshPriceBlock} from './pricing.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import {recoverFreshHistoricalQuote,type FreshHistoricalQuoteEvidence} from './historicalQuote.js';
import {GANG_TOKEN_ADDRESS,FRESH_GANG_HISTORY_FROM_BLOCK,FRESH_GANG_CREATION_HASH,FRESH_GANG_CREATION_TIME,FRESH_GANG_HISTORY_ADMISSION_KEY,freshTokenAdmissionKey,
 validFreshExistingTokenPermission,validFreshGangHistoryPermission,freshTokenAdmissionDigest,freshGangHistoryPermissionDigest,type FreshExistingTokenPermission,type FreshGangHistoryPermission,type FreshTokenAdmission,type FreshTrackingStart} from './tracking.js';

export const GANG_HISTORY_ARCHIVE_ORIGIN='https://bsc-dataseed.bnbchain.org';
export const gangImportStable=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)&&!Buffer.isBuffer(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export const gangImportSha=(v:unknown)=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:gangImportStable(v)).digest('hex');
const fail=(reason:string):never=>{throw Error('gang_import_'+reason);};
const forbidden:Rpc=async()=>{throw Error('gang_import_saved_state_missing');};
const hex=(n:number)=>'0x'+n.toString(16),iso=(v:unknown)=>typeof v==='string'&&new Date(v).toISOString()===v;
export interface GangImportManifest{version:1;kind:'gang_history_import_v1';chainId:56;tokenAddress:typeof GANG_TOKEN_ADDRESS;approvedAt:string;archiveOrigin:typeof GANG_HISTORY_ARCHIVE_ORIGIN;
 files:{path:string;sha256:string;bytes:number}[];dataPath:string;artwork:{path:string;mime:'image/webp';url:'https://gang.fun/api/tokens/GANG/logo'};expected:{receipts:number;activities:number;trades:number;events:number;marketMarks:number};sourceDatasetSha256:string}
export interface GangImportEntry{entry:FreshCapturedReceipt;header:FreshBlock}
export interface GangImportData{version:1;entries:GangImportEntry[];activities:(FreshGangHistoryActivity&{pagePath:string;rowIndex:number})[];oracles:FreshHistoricalQuoteEvidence[];anchorHeaders:FreshBlock[];publicWallets:string[]}
export interface GangImportBundle{manifest:GangImportManifest;manifestSha:string;data:GangImportData;artwork?:Buffer}
export function parseGangImportArgs(args:readonly string[]){
 const named=new Map<string,string>(),flags=new Set<string>();for(let i=0;i<args.length;i++){const key=args[i];if(named.has(key)||flags.has(key))fail('duplicate_argument');
  if(key==='--apply'||key==='--dry-run')flags.add(key);else if(['--bundle','--manifest-sha','--plan-digest'].includes(key)){const value=args[++i];if(!value||value.startsWith('--'))fail('argument_value');named.set(key,value);}else fail('argument');}
 if(flags.has('--apply')===flags.has('--dry-run')||!named.get('--bundle')||!/^[a-f0-9]{64}$/.test(named.get('--manifest-sha')??'')||flags.has('--apply')!==named.has('--plan-digest')||named.has('--plan-digest')&&!/^[a-f0-9]{64}$/.test(named.get('--plan-digest')!))fail('usage');
 return{directory:named.get('--bundle')!,manifestSha:named.get('--manifest-sha')!,apply:flags.has('--apply'),planDigest:named.get('--plan-digest')};
}

/** No manifest member can name a file outside the explicitly mounted import directory. */
export async function loadGangImportBundle(directory:string,manifestSha:string):Promise<GangImportBundle>{
 if(!/^[a-f0-9]{64}$/.test(manifestSha))fail('manifest_sha_required');const base=await realpath(directory);
 const read=async(path:string,max:number)=>{if(!path||path.includes('\\')||isAbsolute(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))fail('artifact_path');
  const full=await realpath(resolve(base,path)),rel=relative(base,full);if(rel.startsWith('..')||isAbsolute(rel))fail('artifact_escape');
  const info=await stat(full);if(!info.isFile()||info.size>max)fail('artifact_size');return readFile(full);};
 const bytes=await read('manifest.json',64*1024);if(gangImportSha(bytes)!==manifestSha)fail('manifest_checksum');
 const m=JSON.parse(bytes.toString()) as GangImportManifest;
 if(m.version!==1||m.kind!=='gang_history_import_v1'||m.chainId!==56||m.tokenAddress!==GANG_TOKEN_ADDRESS||!iso(m.approvedAt)||m.archiveOrigin!==GANG_HISTORY_ARCHIVE_ORIGIN
  ||!Array.isArray(m.files)||m.files.length<1||m.files.length>300||new Set(m.files.map(f=>f.path)).size!==m.files.length||!/^[a-f0-9]{64}$/.test(m.sourceDatasetSha256))fail('manifest_invalid');
 const files=new Map<string,Buffer>();let total=0;
 for(const f of m.files){if(!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>16*1024*1024||!/^[a-f0-9]{64}$/.test(f.sha256))fail('file_manifest');
  const raw=await read(f.path,16*1024*1024);total+=raw.length;if(total>32*1024*1024||raw.length!==f.bytes||gangImportSha(raw)!==f.sha256)fail('artifact_checksum');files.set(f.path,raw);}
 const data=JSON.parse((files.get(m.dataPath)??fail('data_path')).toString()) as GangImportData;
 const artwork=files.get(m.artwork?.path);if(m.artwork?.mime!=='image/webp'||m.artwork.url!=='https://gang.fun/api/tokens/GANG/logo'||!artwork||artwork.length>256*1024||artwork.toString('ascii',0,4)!=='RIFF'||artwork.toString('ascii',8,12)!=='WEBP')fail('artwork_invalid');
 if(data.version!==1||data.entries.length!==m.expected.receipts||data.activities.length!==m.expected.activities||data.entries.length>512||data.activities.length>512||data.entries.length<1
  ||data.publicWallets.length!==226||new Set(data.publicWallets).size!==226||data.publicWallets.some(w=>!/^0x[a-f0-9]{40}$/.test(w)))fail('data_bounds');
 if(new Set(data.entries.map(e=>e.entry.transaction.hash)).size!==data.entries.length)fail('duplicate_receipt');
 if(!Array.isArray(data.oracles)||data.oracles.length>4096||!Array.isArray(data.anchorHeaders)||data.anchorHeaders.length>32)fail('oracle_bounds');
 for(const{entry,header}of data.entries){const n=Number(BigInt(header.number));if(!Number.isSafeInteger(n)||n<FRESH_GANG_HISTORY_FROM_BLOCK||!/^0x[a-f0-9]{64}$/.test(header.hash)||!Number.isSafeInteger(Number(BigInt(header.timestamp))))fail('entry_header');validateFreshReceipt(entry.receipt,entry.transaction,header);}
 for(const a of data.activities){const page=files.get(a.pagePath);if(!page||gangImportSha(page)!==a.pageSha256||!data.publicWallets.includes(a.walletAddress))fail('activity_page');
  const p=JSON.parse(page!.toString());if(gangImportStable(p.response?.data?.activities?.[a.rowIndex])!==gangImportStable(a.row)||p.wallet!==a.walletAddress||p.at!==a.observedAt)fail('activity_row');}
 return{manifest:m,manifestSha,data,artwork};
}

const blockPrice=(b:FreshBlock):FreshPriceBlock=>({number:Number(BigInt(b.number)),hash:b.hash,timestamp:new Date(Number(BigInt(b.timestamp))*1000).toISOString()});
export const gangImportCore=(entry:FreshCapturedReceipt)=>gangImportSha([entry.transaction,entry.receipt]);
const same=(a:unknown,b:unknown)=>gangImportStable(a)===gangImportStable(b);
const txFields=['hash','from','to','input','value','gas','gasPrice','nonce','type','chainId','maxFeePerGas','maxPriorityFeePerGas','accessList','authorizationList','r','s','v','yParity','blockHash','blockNumber','transactionIndex'];
const receiptFields=['transactionHash','transactionIndex','blockHash','blockNumber','from','to','contractAddress','status','gasUsed','effectiveGasPrice','cumulativeGasUsed','logsBloom','type','logs'];
function compareFields(expected:Record<string,unknown>,actual:Record<string,unknown>,fields:string[],reason:string){for(const key of fields)if(expected[key]!==undefined&&!same(expected[key],actual?.[key]))fail(reason+':'+key);}
/** The fallback is a fixed authorized public BSC canonical source, never a financial/state provider. */
export function createGangImportArchiveRpc():Rpc{let calls=0;return async<T>(method:string,params:unknown[]):Promise<T>=>{
 if(!['eth_chainId','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt'].includes(method)||++calls>1200)fail('archive_request');
 const id=calls,response=await fetch(GANG_HISTORY_ARCHIVE_ORIGIN,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(15000)});
 if(response.status===429)fail('archive_cooldown');if(!response.ok)fail('archive_http');const text=await response.text();if(text.length>4*1024*1024)fail('archive_response_size');
 const json=JSON.parse(text);if(json.jsonrpc!=='2.0'||json.id!==id||json.error||json.result==null)fail('archive_unavailable');return json.result as T;};}
export interface GangCanonicalProof{sha256:string;ownHeaders:number;archiveHeaders:number;transactions:number;archiveOrigin:string;headers:{number:number;hash:string;source:'node'|'public_canonical_archive'}[];contexts?:{transactionHash:string;blockHash:string;bodySha256:string;source:'node'|'public_canonical_archive'}[]}
export async function verifyGangImportCanonical(bundle:GangImportBundle,node:Rpc,archive:Rpc):Promise<GangCanonicalProof>{
 if(await node<string>('eth_chainId',[])!=='0x38')fail('node_chain');let archiveChecked=false,ownHeaders=0,archiveHeaders=0;const contexts:NonNullable<GangCanonicalProof['contexts']>=[],deadline=Date.now()+15*60_000;
 const headers=new Map<number,{header:FreshBlock;source:'node'|'public_canonical_archive'}>();
 const wanted=[...bundle.data.entries.map(e=>e.header),...bundle.data.anchorHeaders,{number:hex(FRESH_GANG_HISTORY_FROM_BLOCK-1),hash:FRESH_GANG_CREATION_HASH,timestamp:hex(Math.floor(Date.parse(FRESH_GANG_CREATION_TIME)/1000))}as FreshBlock];
 for(const original of wanted){if(Date.now()>deadline)fail('canonical_deadline');const n=Number(BigInt(original.number));if(headers.has(n)){if(headers.get(n)!.header.hash!==original.hash)fail('header_collision');continue;}
  let actual:FreshBlock|null=null;try{actual=await node<FreshBlock>('eth_getBlockByNumber',[hex(n),false]);}catch{actual=null;}
  let source:'node'|'public_canonical_archive'='node';if(!actual){if(!archiveChecked){if(await archive<string>('eth_chainId',[])!=='0x38')fail('archive_chain');archiveChecked=true;}actual=await archive<FreshBlock>('eth_getBlockByNumber',[hex(n),false]);source='public_canonical_archive';}
  compareFields(original as any,actual as any,['number','hash','parentHash','timestamp'],'canonical_header');
  if(original.transactions?.length&&!same(original.transactions.map(t=>typeof t==='string'?t:t.hash),actual!.transactions.map(t=>typeof t==='string'?t:t.hash)))fail('original_header_membership');
  headers.set(n,{header:actual!,source});source==='node'?ownHeaders++:archiveHeaders++;
 }
 for(const{entry,header}of bundle.data.entries){if(Date.now()>deadline)fail('canonical_deadline');const n=Number(BigInt(header.number)),proof=headers.get(n)!,rpc=proof.source==='node'?node:archive;let source=proof.source;
  validateFreshReceipt(entry.receipt,entry.transaction,header);const member=proof.header.transactions[Number(BigInt(entry.transaction.transactionIndex))];if((typeof member==='string'?member:member?.hash)!==entry.transaction.hash)fail('transaction_membership');
  let tx:Record<string,unknown>|null=null,receipt:Record<string,unknown>|null=null;try{tx=await rpc<Record<string,unknown>>('eth_getTransactionByHash',[entry.transaction.hash]);receipt=await rpc<Record<string,unknown>>('eth_getTransactionReceipt',[entry.transaction.hash]);}catch{if(proof.source==='public_canonical_archive')throw Error('gang_import_archive_context_unavailable');}
  if(!tx||!receipt){if(!archiveChecked){if(await archive<string>('eth_chainId',[])!=='0x38')fail('archive_chain');archiveChecked=true;}
   const headerAgain=await archive<FreshBlock>('eth_getBlockByNumber',[hex(n),false]);compareFields(proof.header as any,headerAgain as any,['number','hash','parentHash','timestamp'],'archive_header');
   const archiveMember=headerAgain.transactions[Number(BigInt(entry.transaction.transactionIndex))];if((typeof archiveMember==='string'?archiveMember:archiveMember?.hash)!==entry.transaction.hash)fail('archive_transaction_membership');
   tx=await archive<Record<string,unknown>>('eth_getTransactionByHash',[entry.transaction.hash]);receipt=await archive<Record<string,unknown>>('eth_getTransactionReceipt',[entry.transaction.hash]);source='public_canonical_archive';}
  compareFields(entry.transaction,tx,txFields,'transaction_context');compareFields(entry.receipt,receipt,receiptFields,'receipt_context');
  contexts.push({transactionHash:entry.transaction.hash,blockHash:entry.transaction.blockHash,bodySha256:gangImportCore(entry),source});
 }
 // Canonical bookends after the full finite verification, with the same authenticated source per header.
 for(const[n,p]of headers){const rpc=p.source==='node'?node:archive,b=await rpc<FreshBlock>('eth_getBlockByNumber',[hex(n),false]);compareFields(p.header as any,b as any,['number','hash','parentHash','timestamp'],'canonical_recheck');}
 const summary={ownHeaders,archiveHeaders,transactions:bundle.data.entries.length,archiveOrigin:GANG_HISTORY_ARCHIVE_ORIGIN,headers:[...headers].map(([number,p])=>({number,hash:p.header.hash,source:p.source})).sort((a,b)=>a.number-b.number),contexts};
 return{...summary,sha256:gangImportSha(summary)};
}

export function gangImportPermissions(start:FreshTrackingStart,bundle:GangImportBundle){
 const common={version:1 as const,chainId:56 as const,tokenAddress:GANG_TOKEN_ADDRESS as typeof GANG_TOKEN_ADDRESS,active:true as const,startBlock:Number(start.block_number),startHash:start.block_hash,startTime:String(start.value.startTime),approvedAt:bundle.manifest.approvedAt};
 const permission:FreshExistingTokenPermission={...common,kind:'explicit_existing',fromBlock:Number(start.block_number)+1,reason:'user_approved_gang_only'};
 const history:FreshGangHistoryPermission={...common,kind:'explicit_token_history',historyFromBlock:FRESH_GANG_HISTORY_FROM_BLOCK,historyFromHash:FRESH_GANG_CREATION_HASH,historyFromTime:FRESH_GANG_CREATION_TIME,sourceDatasetSha256:bundle.manifest.sourceDatasetSha256,policy:'gmgn_gang_only_history_v1'};
 if(!validFreshExistingTokenPermission(permission,start)||!validFreshGangHistoryPermission(history,start))fail('tracking_start');
 const admission:FreshTokenAdmission={kind:'preexisting',permission,history,admissionDigest:gangImportSha(freshTokenAdmissionDigest(permission)+freshGangHistoryPermissionDigest(history)),fromBlock:history.historyFromBlock,launchStatus:'preexisting'};return{permission,history,admission};
}
export async function prepareGangImport(bundle:GangImportBundle,start:FreshTrackingStart){
 const permissions=gangImportPermissions(start,bundle),headers=new Map<number,FreshPriceBlock>();for(const b of[...bundle.data.entries.map(e=>e.header),...bundle.data.anchorHeaders])headers.set(Number(BigInt(b.number)),blockPrice(b));
 const prepared:{entry:FreshCapturedReceipt;header:FreshBlock;decoded:FreshDecodedReceipt;provenance:Record<string,FreshGangHistoryProvenance>}[]=[];
 for(const{entry,header}of [...bundle.data.entries].sort((a,b)=>Number(BigInt(a.header.number)-BigInt(b.header.number))||Number(BigInt(a.entry.transaction.transactionIndex)-BigInt(b.entry.transaction.transactionIndex)))){
  if(entry.wallets.length<1||entry.wallets.some(w=>!bundle.data.publicWallets.includes(w))||Number(BigInt(header.number))<FRESH_GANG_HISTORY_FROM_BLOCK)fail('entry_scope');
  const block=blockPrice(header),proofs=bundle.data.oracles.filter(p=>p.target.hash===block.hash),rows=bundle.data.activities.filter(a=>a.row.tx_hash===entry.transaction.hash&&entry.wallets.includes(a.walletAddress));
  let decoded:FreshDecodedReceipt,provenance:Record<string,FreshGangHistoryProvenance>={};
  if(rows.length){const result=await reconcileFreshGangHistory({entry,block,activities:rows,historicalQuotes:proofs,canonicalHeaders:proofs.map(p=>headers.get(p.anchor.number)!)});decoded=result.decoded;provenance=result.provenanceByEventId;if(result.missingWallets.length)fail('unmatched_movements');}
  else{const state=createFreshStateEvidenceRpc(forbidden,block,entry.stateEvidence);if(state.rejectedPrior)fail('state_envelope');
   const priceUsd=async(token:string)=>{try{return await freshQuoteUsd(token,{rpc:state.rpc,block});}catch{const p=proofs.find(p=>p.tokenAddress===token);return p?(await recoverFreshHistoricalQuote({rpc:forbidden,tokenAddress:token,target:block,anchor:headers.get(p.anchor.number)!,prior:p})).priceUsd:null;}};
   decoded=await normalizeFreshReceipt(entry,header,{knownLaunch:async t=>t===GANG_TOKEN_ADDRESS,eligible:async t=>t.address===GANG_TOKEN_ADDRESS,metadata:async t=>t===GANG_TOKEN_ADDRESS?freshTokenMetadata(t,{rpc:state.rpc,block,requireSupply:false}):null,priceUsd});
  }
  if(decoded.events.some(e=>e.tokenAddress!==GANG_TOKEN_ADDRESS))fail('foreign_fact');for(const event of decoded.events)validateFreshFinancialEvent(event);
  if(decoded.reasons.some(r=>!['incoming_transfer_cost_unknown','outgoing_transfer_value_unknown'].includes(r)))fail('unresolved_receipt:'+entry.transaction.hash+':'+decoded.reasons.join(','));
  const mark=await recoverFreshGangTradeMarketMark({entry,block,admission:permissions.admission,canonicalHeader:async n=>headers.get(n)??null,historicalBnbFeed:proofs.find(p=>p.tokenAddress===WBNB)});if(mark)decoded.gangMarketMarks=[mark];
  prepared.push({entry,header,decoded,provenance});
 }
 const events=prepared.flatMap(p=>p.decoded.events),counts={receipts:prepared.length,activities:bundle.data.activities.length,events:events.length,trades:events.filter(e=>e.kind==='buy'||e.kind==='sell').length,marketMarks:prepared.flatMap(p=>p.decoded.gangMarketMarks??[]).length};
 if(!same(counts,bundle.manifest.expected))fail('normalized_counts');if(new Set(events.map(e=>e.id)).size!==events.length)fail('duplicate_event');
 return{permissions,prepared,events,counts};
}
export type GangImportPrepared=Awaited<ReturnType<typeof prepareGangImport>>;
/** Preserve immutable bodies and every existing successful raw read. Mutable
 * monitoring/diagnostics retain their current values; this import adds proof only. */
export function mergeGangImportEvidence(current:FreshCapturedReceipt,incoming:FreshCapturedReceipt){
 if(gangImportCore(current)!==gangImportCore(incoming))fail('original_body_conflict');
 const target=blockPrice({number:current.transaction.blockNumber,hash:current.transaction.blockHash,timestamp:hex(Math.floor(Date.parse(incoming.observedAt)/1000))} as FreshBlock);
 const a=current.stateEvidence,b=incoming.stateEvidence;if(a&&(a.blockHash!==target.hash||a.blockNumber!==target.number)||b&&(b.blockHash!==target.hash||b.blockNumber!==target.number))fail('state_target');
 const calls=new Map<string,{to:string;data:string;result:string}>();for(const call of[...(a?.calls??[]),...(b?.calls??[])]){const key=call.to+':'+call.data;if(calls.has(key)&&calls.get(key)!.result!==call.result)fail('raw_read_conflict');calls.set(key,call);}
 const stateEvidence=calls.size?{version:1 as const,blockNumber:target.number,blockHash:target.hash,calls:[...calls.values()]}:undefined;
 if(stateEvidence&&createFreshStateEvidenceRpc(forbidden,target,stateEvidence).rejectedPrior)fail('merged_state_bounds');
 return{...current,...(stateEvidence?{stateEvidence}:{}),wallets:[...new Set([...current.wallets,...incoming.wallets])].sort(),historicalWallets:[...new Set([...(current.historicalWallets??[]),...incoming.wallets])].sort()};
}
const requiredFields=['executionKey','walletAddress','tokenAddress','kind','quantity','blockNumber','blockHash','transactionHash','transactionIndex','executionIndex','logIndex','occurredAt','feeKey','counterparty','transferKey'] as const;
const valuedFields=['amountUsd','feeUsd','quoteAddress','quoteSymbol','quoteAmount','acquisitionCost','feeAttribution'] as const;
export function preserveGangImportFact(previous:FreshFinancialEvent,next:FreshFinancialEvent){
 if(previous.canonical===false||next.canonical===false||requiredFields.some(k=>!same(previous[k],next[k])))fail('existing_fact_identity_conflict:'+previous.id);
 for(const key of valuedFields)if(previous[key]!=null&&next[key]!=null&&!same(previous[key],next[key]))fail('known_financial_conflict:'+previous.id+':'+key);
 const result={...next};for(const key of valuedFields)if(previous[key]!=null)Object.assign(result,{[key]:previous[key]});return result;
}

interface GangImportSnapshot{start:FreshTrackingStart;permissions:any[];roles:any[];scopes:any[];memberships:any[];facts:any[];receipts:any[];headers:any[];excluded:any[];token:any[];digest:string}
async function snapshot(client:PoolClient,bundle:GangImportBundle):Promise<GangImportSnapshot>{
 const txs=bundle.data.entries.map(e=>e.entry.transaction.hash),wallets=bundle.data.publicWallets;
 const start=(await client.query("SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start'")).rows[0];if(!start)fail('uninitialized_database');
 const permissions=(await client.query('SELECT key,value FROM fresh.checkpoints WHERE key=ANY($1::text[]) ORDER BY key',[[freshTokenAdmissionKey(GANG_TOKEN_ADDRESS),FRESH_GANG_HISTORY_ADMISSION_KEY]])).rows;
 const roles=(await client.query(`SELECT k.wallet_address,k.is_tracked,w.active,s.id,s.starts_block::text,s.starts_at FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address JOIN fresh.accounting_scopes s ON s.id='kol:'||w.address AND s.kind='kol' AND s.account_id IS NULL AND s.active AND s.wallet_addresses=ARRAY[w.address]::text[] WHERE k.wallet_address=ANY($1::text[]) ORDER BY k.wallet_address`,[wallets])).rows;
 if(roles.length!==226||roles.some(r=>!r.is_tracked||!r.active))fail('public_roster_changed');
 const allTracked=(await client.query('SELECT wallet_address FROM fresh.kols WHERE is_tracked ORDER BY wallet_address')).rows.map(r=>r.wallet_address);if(!same(allTracked,[...wallets].sort()))fail('public_roster_changed');
 const affectedWallets=[...new Set(bundle.data.entries.flatMap(e=>e.entry.wallets))];
 const scopes=(await client.query('SELECT id,kind,account_id,wallet_addresses,starts_block::text,starts_at,active,revision::text,correction_epoch::text FROM fresh.accounting_scopes WHERE active AND wallet_addresses && $1::text[] ORDER BY id',[affectedWallets])).rows;
 const memberships=(await client.query('SELECT j.* FROM public.journal_wallets j WHERE j.wallet_address=ANY($1::text[]) ORDER BY j.user_id,j.wallet_address',[affectedWallets])).rows;
 const facts=(await client.query('SELECT * FROM fresh.financial_events WHERE transaction_hash=ANY($1::text[]) ORDER BY id',[txs])).rows;
 const receipts=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=ANY($1::text[]) ORDER BY tx_hash,block_hash',[txs])).rows;
 const headerNumbers=[...new Set([...bundle.data.entries.map(e=>Number(BigInt(e.header.number))),...bundle.data.anchorHeaders.map(h=>Number(BigInt(h.number)))])];
 const headers=(await client.query('SELECT block_number::text,block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=ANY($1::bigint[]) ORDER BY block_number',[headerNumbers])).rows;
 const excluded=(await client.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1',[GANG_TOKEN_ADDRESS])).rows;if(excluded.some(r=>r.status==='excluded_non_token'))fail('token_excluded');
 const token=(await client.query('SELECT * FROM fresh.tokens WHERE address=$1',[GANG_TOKEN_ADDRESS])).rows;
 const stableToken=token.map(t=>({address:t.address,launch_status:t.launch_status}));
 const core={start,permissions,roles,scopes,memberships,facts,receipts,headers,excluded,token:stableToken};return{...core,token,digest:gangImportSha(core)};
}
function bindFacts(prepared:GangImportPrepared,saved:any[]){
 const aliases=new Map<string,string>(),changes:{id:string;fields:string[]}[]=[],before=new Map(saved.map(r=>[r.id,freshEventFromRow(r)]));
 for(const work of prepared.prepared)for(let i=0;i<work.decoded.events.length;i++){
  let next=work.decoded.events[i],prior=before.get(next.id);if(!prior&&next.kind.startsWith('transfer_')){const matches=saved.filter(r=>r.canonical&&r.wallet_address===next.walletAddress&&r.token_address===next.tokenAddress&&r.kind===next.kind&&r.block_hash===next.blockHash&&r.transaction_hash===next.transactionHash&&r.log_index===next.logIndex);
   if(matches.length>1)fail('transfer_alias_ambiguous');if(matches.length){const oldId=next.id;prior=freshEventFromRow(matches[0]);next={...next,id:prior.id,executionKey:prior.executionKey};aliases.set(oldId,prior.id);}}
  if(prior){next=preserveGangImportFact(prior,next);const fields=valuedFields.filter(k=>!same(prior![k],next[k]));if(fields.length)changes.push({id:next.id,fields:[...fields]});}else changes.push({id:next.id,fields:['new']});
  work.decoded.events[i]=next;
 }
 if(aliases.size)for(const work of prepared.prepared){for(const[oldId,newId]of aliases){if(work.provenance[oldId]){work.provenance[newId]=work.provenance[oldId];delete work.provenance[oldId];}if(work.decoded.tradeBnbPrices?.[oldId]){work.decoded.tradeBnbPrices[newId]=work.decoded.tradeBnbPrices[oldId];delete work.decoded.tradeBnbPrices[oldId];}}}
 const events=prepared.prepared.flatMap(w=>w.decoded.events);
 const fees=saved.filter(r=>r.canonical&&r.kind==='fee'&&!r.token_address&&events.some(e=>e.kind!=='fee'&&e.feeKey&&e.feeKey===r.fee_key));
 if(fees.length)fail('unallocated_fee_overlap_requires_review:'+fees.length);
 return{events,changes,aliases:[...aliases]};
}
export interface GangImportPlan{version:1;kind:'gang_history_import_plan_v1';manifestSha:string;canonicalProofSha:string;baselineSha:string;normalizedSha:string;allowedScopesSha:string;counts:GangImportPrepared['counts'];changes:{id:string;fields:string[]}[];publicBooks:number;privateBooks:number;digest:string}
export async function planGangImport(client:PoolClient,bundle:GangImportBundle,canonical:GangCanonicalProof){
 const before=await snapshot(client,bundle),prepared=await prepareGangImport(bundle,before.start),bound=bindFacts(prepared,before.facts);
 for(const header of[...bundle.data.entries.map(e=>e.header),...bundle.data.anchorHeaders]){const old=before.headers.find(h=>h.block_number===String(Number(BigInt(header.number))));if(old&&(old.block_hash!==header.hash||old.parent_hash!==header.parentHash||new Date(old.occurred_at).toISOString()!==blockPrice(header).timestamp))fail('stored_header_conflict');}
 for(const work of prepared.prepared){const current=before.receipts.filter(r=>r.tx_hash===work.entry.transaction.hash);if(current.some(r=>r.block_hash!==work.header.hash))fail('existing_orphan_receipt');if(current.length)mergeGangImportEvidence(decodeFreshEvidence(current[0].payload),work.entry);}
 for(const p of before.permissions){const expected=p.key===FRESH_GANG_HISTORY_ADMISSION_KEY?prepared.permissions.history:prepared.permissions.permission;
  // A valid prior GANG-only permission may predate this recovery. Preserve its approval date.
  const checker=p.key===FRESH_GANG_HISTORY_ADMISSION_KEY?validFreshGangHistoryPermission:validFreshExistingTokenPermission;
  if(!checker(p.value,before.start)||!same({...p.value,approvedAt:expected.approvedAt},expected))fail('permission_conflict');if(p.key===FRESH_GANG_HISTORY_ADMISSION_KEY)prepared.permissions.history=p.value;else prepared.permissions.permission=p.value;
 }
 const normalizedSha=gangImportSha(prepared.prepared.map(p=>({events:p.decoded.events,provenance:p.provenance,marks:p.decoded.gangMarketMarks??[]})));
 const changed=new Set(bound.changes.map(c=>c.id)),affected=before.scopes.filter(s=>bound.events.some(e=>{if(!changed.has(e.id)||!s.wallet_addresses.includes(e.walletAddress))return false;
  if(s.kind==='kol'&&s.account_id===null&&s.id==='kol:'+e.walletAddress&&s.wallet_addresses.length===1)return Number(e.blockNumber)>=FRESH_GANG_HISTORY_FROM_BLOCK&&Date.parse(e.occurredAt)>=Date.parse(FRESH_GANG_CREATION_TIME);
  const member=before.memberships.find(j=>String(j.user_id)===s.account_id&&j.wallet_address===e.walletAddress);return s.account_id!==null&&member&&Number(e.blockNumber)>=Number(s.starts_block)&&Date.parse(e.occurredAt)>=new Date(s.starts_at).getTime()&&Number(e.blockNumber)>=Number(member.registration_block??s.starts_block)&&Date.parse(e.occurredAt)>=new Date(member.activity_from).getTime();}));
 const allowedScopeIds=affected.map(s=>s.id).sort();
 const core={version:1 as const,kind:'gang_history_import_plan_v1' as const,manifestSha:bundle.manifestSha,canonicalProofSha:canonical.sha256,baselineSha:before.digest,normalizedSha,allowedScopesSha:gangImportSha(allowedScopeIds),counts:prepared.counts,changes:bound.changes,
  publicBooks:affected.filter(s=>s.account_id===null).length,privateBooks:affected.filter(s=>s.account_id!==null).length};
 return{plan:{...core,digest:gangImportSha(core)}as GangImportPlan,before,prepared,allowedScopeIds};
}
/** APPLY is the only mutator; schema setup and source/identity imports are forbidden. */
export async function applyGangImport(client:PoolClient,bundle:GangImportBundle,canonical:GangCanonicalProof,expectedPlanDigest:string,now=new Date()){
 await client.query('SELECT pg_advisory_xact_lock(73621941)');await client.query('SELECT pg_advisory_xact_lock(73621943)');
 // Portfolio registration/removal serializes on the existing capture row.
 // Use that same guard before reading memberships, without moving capture.
 if(!(await client.query("SELECT key FROM fresh.checkpoints WHERE key='capture' FOR UPDATE")).rowCount)fail('capture_checkpoint_required');
 const work=await planGangImport(client,bundle,canonical);if(work.plan.digest!==expectedPlanDigest)fail('plan_changed');
 const{before,prepared}=work,permissionKeys=[freshTokenAdmissionKey(GANG_TOKEN_ADDRESS),FRESH_GANG_HISTORY_ADMISSION_KEY];
 for(const id of before.scopes.map(s=>s.id).sort())await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fresh-scope:'+id]);
 await client.query("SELECT key FROM fresh.checkpoints WHERE key='start' OR key=ANY($1::text[]) ORDER BY key FOR UPDATE",[permissionKeys]);
 await client.query('SELECT k.wallet_address FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address JOIN fresh.accounting_scopes s ON s.id=\'kol:\'||w.address WHERE k.wallet_address=ANY($1::text[]) ORDER BY k.wallet_address FOR SHARE OF k,w,s',[bundle.data.publicWallets]);
 await client.query('SELECT id FROM fresh.accounting_scopes WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[before.scopes.map(s=>s.id)]);
 await client.query('SELECT j.wallet_address FROM public.journal_wallets j WHERE j.wallet_address=ANY($1::text[]) ORDER BY j.user_id,j.wallet_address FOR SHARE',[[...new Set(bundle.data.entries.flatMap(e=>e.entry.wallets))]]);
 if((await snapshot(client,bundle)).digest!==before.digest)fail('locked_context_changed');
 for(const[key,value]of[[permissionKeys[0],prepared.permissions.permission],[permissionKeys[1],prepared.permissions.history]]as const)await client.query('INSERT INTO fresh.checkpoints(key,value)VALUES($1,$2::jsonb)ON CONFLICT(key)DO NOTHING',[key,JSON.stringify(value)]);
 for(const h of new Map([...bundle.data.entries.map(e=>e.header),...bundle.data.anchorHeaders].map(h=>[h.number,h])).values())await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at)VALUES($1,$2,$3,$4)ON CONFLICT(block_number)DO NOTHING',[Number(BigInt(h.number)),h.hash,h.parentHash,blockPrice(h).timestamp]);
 const changedIds=new Set(work.plan.changes.map(e=>e.id)),contexts=prepared.prepared.map(p=>p.decoded);
 // A single ordinary correction batch rebuilds affected books once, with their
 // existing Portfolio floors. A verified rerun has no financial correction batch.
 const aggregate:FreshDecodedReceipt={events:prepared.prepared.flatMap(p=>p.decoded.events).filter(e=>changedIds.has(e.id)),tokens:prepared.prepared.flatMap(p=>p.decoded.tokens).sort((a,b)=>a.block.number-b.block.number).slice(-1),reasons:[],executions:prepared.prepared.reduce((n,p)=>n+p.decoded.executions,0)};
 const contextEvents=new Set(aggregate.events.map(e=>e.id));const correctionContexts=contexts.map(c=>({...c,events:c.events.filter(e=>contextEvents.has(e.id)),tradeBnbPrices:undefined,gangMarketMarks:undefined}));
 if(aggregate.events.length)await persistFreshDecodedReceipt(client,aggregate,now,correctionContexts,work.allowedScopeIds);
 // Explicit existing-token admission is independent of newer current metadata.
 await client.query("UPDATE fresh.tokens SET launch_status='preexisting' WHERE address=$1 AND launch_status IS DISTINCT FROM 'preexisting'",[GANG_TOKEN_ADDRESS]);
 if(bundle.artwork)await client.query(`UPDATE fresh.tokens SET logo_data=COALESCE(logo_data,$2),logo_mime=CASE WHEN logo_data IS NULL THEN $3 ELSE logo_mime END,logo_url=COALESCE(logo_url,$4) WHERE address=$1 AND (logo_data IS NULL OR logo_url IS NULL)`,[GANG_TOKEN_ADDRESS,bundle.artwork,bundle.manifest.artwork.mime,bundle.manifest.artwork.url]);
 // Display-only proof writers do not replay accounting or update counters.
 for(const c of contexts){for(const[id,rate]of Object.entries(c.tradeBnbPrices??{})){const event=c.events.find(e=>e.id===id);if(!event)fail('display_event_missing');await persistFreshTradeBnbPrice(client,event!,rate);}for(const mark of c.gangMarketMarks??[])await persistFreshGangTradeMarketMark(client,mark);}
 await removeFreshResolvedPendingTrades(client,prepared.prepared.flatMap(p=>p.decoded.events).filter(e=>e.kind==='buy'||e.kind==='sell').map(e=>e.id));
 let newReceipts=0,mergedReceipts=0;
 for(const p of prepared.prepared){const current=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR UPDATE',[p.entry.transaction.hash,p.header.hash])).rows[0];
  if(current){const old=decodeFreshEvidence(current.payload),merged=mergeGangImportEvidence(old,p.entry);if(!same(old,merged)){await client.query('UPDATE fresh.recent_evidence SET payload=$3,wallet_addresses=$4 WHERE tx_hash=$1 AND block_hash=$2',[p.entry.transaction.hash,p.header.hash,encodeFreshEvidence(merged),merged.wallets]);mergedReceipts++;}
   if(!p.decoded.reasons.length&&old.wallets.every(w=>p.entry.wallets.includes(w)))await client.query("UPDATE fresh.recent_evidence SET decoder_status='done',decoder_version=$3 WHERE tx_hash=$1 AND block_hash=$2 AND (decoder_status<>'done' OR decoder_version<>$3)",[p.entry.transaction.hash,p.header.hash,FRESH_DECODER_VERSION]);}
  else{const quiet={...p.entry,historicalWallets:[...new Set([...(p.entry.historicalWallets??[]),...p.entry.wallets])].sort()};await client.query(`INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,decoder_version,last_error,expires_at,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
   [p.entry.transaction.hash,p.header.hash,Number(BigInt(p.header.number)),Number(BigInt(p.entry.transaction.transactionIndex)),encodeFreshEvidence(quiet),p.entry.wallets,p.decoded.reasons.length?'repair':'done',FRESH_DECODER_VERSION,p.decoded.reasons.join(',')||null,new Date(Date.parse(p.entry.observedAt)+72*3600_000),p.entry.observedAt]);newReceipts++;}
  for(const[id,proof]of Object.entries(p.provenance))await client.query('UPDATE fresh.financial_events SET provenance=$2::jsonb WHERE id=$1 AND provenance IS NULL',[id,JSON.stringify({...proof,importManifestSha256:bundle.manifestSha,canonicalProofSha256:canonical.sha256,canonicalOrigin:canonical.contexts?.find(c=>c.transactionHash===p.entry.transaction.hash)?.source??'reviewed_fixture'})]);
 }
 const oldIds=new Set(before.facts.map(f=>f.id)),newIds=prepared.prepared.flatMap(p=>p.decoded.events.map(e=>e.id)).filter(id=>!oldIds.has(id));
 if(newIds.length)await client.query('UPDATE fresh.financial_events SET observed_live=false,telegram_notification_processed=true WHERE id=ANY($1::text[])',[newIds]);
 const after=await snapshot(client,bundle),afterById=new Map(after.facts.map(r=>[r.id,r]));
 for(const old of before.facts){const next=afterById.get(old.id);if(!next)fail('original_fact_removed');const a=freshEventFromRow(old),b=freshEventFromRow(next);for(const[k,v]of Object.entries(a))if(v!=null&&!same(v,(b as any)[k]))fail('original_fact_changed:'+old.id+':'+k);
  for(const k of['observed_live','telegram_notification_processed'])if(!same(old[k],next[k]))fail('original_delivery_changed:'+k);if(old.provenance!=null&&!same(old.provenance,next.provenance))fail('original_provenance_changed');}
 for(const old of before.receipts){const next=after.receipts.find(r=>r.tx_hash===old.tx_hash&&r.block_hash===old.block_hash);if(!next||gangImportCore(decodeFreshEvidence(old.payload))!==gangImportCore(decodeFreshEvidence(next.payload))||!same(old.expires_at,next.expires_at))fail('original_receipt_changed');}
 if(!same(before.start,after.start)||!same(before.roles,after.roles)||!same(before.memberships,after.memberships))fail('identity_or_boundary_changed');
 await client.query('INSERT INTO fresh.checkpoints(key,value)VALUES($1,$2::jsonb)ON CONFLICT(key)DO NOTHING',['gang_history_import:'+bundle.manifestSha,JSON.stringify({version:1,kind:'gang_history_import_audit_v1',manifestSha256:bundle.manifestSha,canonicalProofSha256:canonical.sha256,sourceDatasetSha256:bundle.manifest.sourceDatasetSha256,planDigest:work.plan.digest,completedAt:now.toISOString(),newFacts:newIds.length,repairedFacts:work.plan.changes.length-newIds.length,publicBooks:work.plan.publicBooks,privateBooks:work.plan.privateBooks})]);
 return{plan:work.plan,newReceipts,mergedReceipts,newFacts:newIds.length,repairedFacts:work.plan.changes.length-newIds.length,financialRebuildBatches:aggregate.events.length?1:0,privateBooks:work.plan.privateBooks,afterSha:after.digest,realMessages:0};
}
export async function runGangImport(pool:Pool,bundle:GangImportBundle,canonical:GangCanonicalProof,options:{apply?:boolean;planDigest?:string}){
 const client=await pool.connect();try{await client.query(options.apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='120s'");await client.query("SET LOCAL lock_timeout='5s'");
  if((await client.query('SELECT current_database() AS name')).rows[0]?.name!=='kollens_fresh_v14')fail('production_database_required');
  const start=(await client.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start'")).rows[0];
  if(start?.block_number!=='129627586'||start.block_hash!=='0x11a1ab790a8a32d1ef7569c17447bb0283ab534d5231951fc6e3f384cd049d27')fail('production_boundary_changed');
  if(options.apply&&!/^[a-f0-9]{64}$/.test(options.planDigest??''))fail('apply_plan_required');
  const result=options.apply?await applyGangImport(client,bundle,canonical,options.planDigest!):{plan:(await planGangImport(client,bundle,canonical)).plan,readOnly:true};
  await client.query(options.apply?'COMMIT':'ROLLBACK');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
