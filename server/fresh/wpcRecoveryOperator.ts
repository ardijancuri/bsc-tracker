import{createHash}from'node:crypto';import{readFile,realpath,stat}from'node:fs/promises';import{resolve,relative,isAbsolute}from'node:path';
import type{Pool,PoolClient}from'pg';import type{Rpc}from'../rpc.js';import{WBNB}from'../launchpad.js';
import{decodeFreshEvidence,encodeFreshEvidence,validateFreshReceipt,type FreshBlock,type FreshCapturedReceipt}from'./capture.js';
import{validateFreshTokenCreationProof,type FreshTokenCreationProof}from'./discovery.js';import{validateFreshTrace}from'./trace.js';
import{certifyFreshCompleteCallTrace,validFreshCompleteCallTrace}from'./passiveIncoming.js';
import{normalizeFreshReceipt,persistFreshDecodedReceipt,type FreshDecodedReceipt,FRESH_DECODER_VERSION}from'./decode.js';
import{FreshRational,freshEventFromRow,type FreshFinancialEvent}from'./accounting.js';import{createFreshStateEvidenceRpc}from'./stateEvidence.js';
import{freshTokenMetadata,freshQuoteUsd,type FreshPriceBlock}from'./pricing.js';
import{persistFreshTradeBnbPrice}from'./tradeBnbDisplay.js';
import{authenticateFreshStockwavePoolInitialization,validFreshStockwaveMarketIdentity,freshStockwaveRawQuoteRatio,stockwavePoolManagerInterface,type FreshStockwaveMarketIdentity}from'./stockwaveMarket.js';
import{mergeGangImportEvidence,preserveGangImportFact}from'./gangHistoryImportOperator.js';import{freshScopeEventSql}from'./tracking.js';

export const WPC_RECOVERY_TOKEN='0xd4d12753850347694c40b329b58706484713c6ea';
export const WPC_RECOVERY_START={number:129627586,hash:'0x11a1ab790a8a32d1ef7569c17447bb0283ab534d5231951fc6e3f384cd049d27'};
export const wpcStable=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)&&!Buffer.isBuffer(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export const wpcSha=(v:unknown)=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:wpcStable(v)).digest('hex');
const same=(a:unknown,b:unknown)=>wpcStable(a)===wpcStable(b),noWire:Rpc=async()=>{throw Error('wpc_recovery_historical_wire_forbidden');};
function fail(reason:string):never{throw Error('wpc_recovery_'+reason);}
const n=(v:string)=>{const q=Number(BigInt(v));if(!Number.isSafeInteger(q))fail('quantity');return q;};
const h=(b:FreshBlock)=>({number:n(b.number),hash:b.hash,parentHash:b.parentHash,timestamp:new Date(n(b.timestamp)*1000).toISOString()});
const priceBlock=(b:FreshBlock):FreshPriceBlock=>({number:n(b.number),hash:b.hash,timestamp:h(b).timestamp});
export interface WpcRecoveryManifest{version:1;kind:'wpc_canonical_recovery_v1';chainId:56;tokenAddress:typeof WPC_RECOVERY_TOKEN;files:{path:string;sha256:string;bytes:number}[];dataPath:string;codeArchivePath:string;traceArchivePath:string;stateSourcePaths:string[];expected:{receipts:number;events:number;trades:number;marks:number}}
export interface WpcRecoveryData{version:1;creation:FreshTokenCreationProof;identity:FreshStockwaveMarketIdentity;entries:{entry:FreshCapturedReceipt;header:FreshBlock}[];publicWallets:string[];inventoryThrough:{number:number;hash:string}}
export interface WpcRecoveryBundle{manifest:WpcRecoveryManifest;manifestSha:string;data:WpcRecoveryData;codeArchive:any;traceArchive:any;stateSources:any[]}

export function parseWpcRecoveryArgs(args:readonly string[]){const values=new Map<string,string>(),flags=new Set<string>();for(let i=0;i<args.length;i++){const key=args[i];if(values.has(key)||flags.has(key))fail('duplicate_argument');if(['--apply','--dry-run'].includes(key))flags.add(key);else if(['--bundle','--manifest-sha','--plan-digest'].includes(key)){const value=args[++i];if(!value||value.startsWith('--'))fail('argument_value');values.set(key,value);}else fail('argument');}
 if(flags.has('--apply')===flags.has('--dry-run')||!values.get('--bundle')||!/^[a-f0-9]{64}$/.test(values.get('--manifest-sha')??'')||flags.has('--apply')!==values.has('--plan-digest')||values.has('--plan-digest')&&!/^[a-f0-9]{64}$/.test(values.get('--plan-digest')!))fail('usage');return{directory:values.get('--bundle')!,manifestSha:values.get('--manifest-sha')!,apply:flags.has('--apply'),planDigest:values.get('--plan-digest')};}
export async function loadWpcRecoveryBundle(directory:string,expectedSha:string):Promise<WpcRecoveryBundle>{
 if(!/^[a-f0-9]{64}$/.test(expectedSha))fail('manifest_sha_required');const base=await realpath(directory),read=async(path:string,max:number)=>{if(!path||isAbsolute(path)||path.includes('\\')||path.split('/').some(x=>!x||x==='.'||x==='..'))fail('path');const full=await realpath(resolve(base,path)),rel=relative(base,full);if(isAbsolute(rel)||rel.startsWith('..'))fail('path_escape');const info=await stat(full);if(!info.isFile()||info.size>max)fail('file_size');return readFile(full);};
 const raw=await read('manifest.json',64*1024);if(wpcSha(raw)!==expectedSha)fail('manifest_checksum');const manifest=JSON.parse(raw.toString())as WpcRecoveryManifest;
 if(manifest.version!==1||manifest.kind!=='wpc_canonical_recovery_v1'||manifest.chainId!==56||manifest.tokenAddress!==WPC_RECOVERY_TOKEN||manifest.files.length>16||new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length)fail('manifest');
 const files=new Map<string,Buffer>();let total=0;for(const f of manifest.files){const bytes=await read(f.path,8*1024*1024);total+=bytes.length;if(total>16*1024*1024||bytes.length!==f.bytes||wpcSha(bytes)!==f.sha256)fail('file_checksum');files.set(f.path,bytes);}
 const json=(path:string)=>JSON.parse((files.get(path)??fail('missing_artifact')).toString()),data=json(manifest.dataPath)as WpcRecoveryData;
 if(data.version!==1||data.creation.tokenAddress!==WPC_RECOVERY_TOKEN||data.entries.length!==manifest.expected.receipts||data.entries.length<1||data.entries.length>64||new Set(data.entries.map(e=>e.entry.transaction.hash)).size!==data.entries.length||data.publicWallets.length<1||data.publicWallets.length>16||new Set(data.publicWallets).size!==data.publicWallets.length||data.publicWallets.some(w=>!/^0x[a-f0-9]{40}$/.test(w))||!Number.isSafeInteger(data.inventoryThrough?.number)||data.inventoryThrough.number<Math.max(...data.entries.map(e=>n(e.header.number)))||!/^0x[a-f0-9]{64}$/.test(data.inventoryThrough.hash))fail('data');
 for(const{entry,header}of data.entries){validateFreshReceipt(entry.receipt,entry.transaction,header);if(n(header.number)<=WPC_RECOVERY_START.number||entry.wallets.some(w=>!data.publicWallets.includes(w))||!entry.wallets.length||!entry.receipt.logs.some(l=>l.address===WPC_RECOVERY_TOKEN)&&entry.transaction.to!==WPC_RECOVERY_TOKEN)fail('foreign_context');}
 if(!Array.isArray(manifest.stateSourcePaths)||manifest.stateSourcePaths.length<1||manifest.stateSourcePaths.length>8)fail('state_sources');
 return{manifest,manifestSha:expectedSha,data,codeArchive:json(manifest.codeArchivePath),traceArchive:json(manifest.traceArchivePath),stateSources:manifest.stateSourcePaths.map(json)};
}
/** Actual immutable raw request/response bytes, not a fabricated old eth_call. */
function rawRequests(input:any){const wire=input.requests??input.wire;if(!Array.isArray(wire)||wire.length>32)fail('rpc_artifact');return wire.map((r:any)=>{if(r.status!==200||typeof r.responseBody!=='string'||wpcSha(r.responseBody)!==r.responseSha256)fail('rpc_checksum');const response=JSON.parse(r.responseBody);if(response.jsonrpc!=='2.0'||response.id!==r.request?.id||response.error||response.result==null)fail('rpc_identity');return{request:r.request,result:response.result};});}
export function wpcBirthCodeFromArchive(bundle:WpcRecoveryBundle,token:string,block:{number:number;hash:string}){
 if(token!==WPC_RECOVERY_TOKEN)return null;const requests=rawRequests(bundle.codeArchive);if(!requests.some((r:any)=>r.request.method==='eth_chainId'&&r.result==='0x38'))fail('archive_chain');
 const index=requests.findIndex((r:any)=>r.request.method==='eth_getCode'&&r.request.params?.[0]===token&&r.request.params?.[1]==='0x'+block.number.toString(16));if(index<0)return null;
 const before=requests.slice(0,index).reverse().find((r:any)=>r.request.method==='eth_getBlockByNumber'&&n(r.request.params[0])===block.number),after=requests.slice(index+1).find((r:any)=>r.request.method==='eth_getBlockByNumber'&&n(r.request.params[0])===block.number);
 if(!before||!after||before.result.hash!==block.hash||!same(h(before.result),h(after.result)))fail('archive_code_bookends');return String(requests[index].result);
}
function verifyCreationTrace(bundle:WpcRecoveryBundle){const proof=bundle.data.creation,requests=rawRequests(bundle.traceArchive),trace=requests.find((r:any)=>r.request.method==='debug_traceTransaction');
 if(!trace||trace.request.params?.[0]!==proof.entry.transaction.hash||trace.request.params[1]?.tracer!=='callTracer'||trace.request.params[1]?.tracerConfig?.onlyTopCall!==false||trace.request.params[1]?.tracerConfig?.withLog!==false||!same(validateFreshTrace(trace.result),validateFreshTrace(proof.entry.trace)))fail('archive_trace');
 const before=requests.find((r:any)=>r.request.method==='eth_getBlockByNumber'),after=[...requests].reverse().find((r:any)=>r.request.method==='eth_getBlockByNumber');if(!before||!after||!same(h(before.result),h(proof.block))||!same(h(after.result),h(proof.block)))fail('archive_trace_bookends');}
export function mergeWpcRecoveryEvidence(current:FreshCapturedReceipt,incoming:FreshCapturedReceipt,bundle:WpcRecoveryBundle){
 const merged:FreshCapturedReceipt=mergeGangImportEvidence(current,incoming);
 // These are original attestation inputs, not import flags. Financial rows are
 // muted separately; adding even an empty historicalWallets array changes the
 // complete-trace context hash and is unnecessary for this finite recovery.
 merged.wallets=structuredClone(current.wallets);
 if(Object.hasOwn(current,'historicalWallets'))merged.historicalWallets=structuredClone(current.historicalWallets);
 else delete merged.historicalWallets;
 const complete=(entry:FreshCapturedReceipt)=>{try{return !!entry.trace&&validFreshCompleteCallTrace(entry,validateFreshTrace(entry.trace));}catch{return false;}};
 if(current.completeTraceProof&&!complete(current)){
  // A prior local rehearsal appended exactly this empty marker after an
  // otherwise identical supported proof was certified. Restore only the
  // independently retained original context, never arbitrary membership.
  if(!Array.isArray(current.historicalWallets)||current.historicalWallets.length!==0||Object.hasOwn(incoming,'historicalWallets')
   ||!same(current.wallets,incoming.wallets)||current.observedAt!==incoming.observedAt
   ||!same(current.trace,incoming.trace)||!same(current.completeTraceProof,incoming.completeTraceProof)||!complete(incoming))fail('existing_trace_attestation_invalid');
  delete merged.historicalWallets;
 }
 if(incoming.trace){if(current.trace&&!same(validateFreshTrace(current.trace),validateFreshTrace(incoming.trace)))fail('existing_trace_conflict');
  if(!current.trace)merged.trace=structuredClone(incoming.trace);
  if(!current.completeTraceProof&&incoming.completeTraceProof){verifyCreationTrace(bundle);const request=rawRequests(bundle.traceArchive).find((r:any)=>r.request.method==='debug_traceTransaction')!.request;merged.completeTraceProof=certifyFreshCompleteCallTrace(merged,merged.trace,request,'operator_archive');}
 }
 if(merged.completeTraceProof&&!complete(merged))fail('merged_trace_attestation_invalid');
 return merged;
}
/** Reconcile every imported state scalar to a retained KFE1 observation or a
 * genuine exact-block eth_call with authentic before/after header bookends. */
export function verifyWpcRecoveryStateSources(bundle:WpcRecoveryBundle){
 const reads=new Map<string,string>(),add=(hash:string,to:string,data:string,result:string)=>{const key=hash+':'+to+':'+data;if(reads.has(key)&&reads.get(key)!==result)fail('state_source_conflict');reads.set(key,result);};
 for(const source of bundle.stateSources){
  if(Array.isArray(source.entries))for(const row of source.entries){if(typeof row.originalPayloadBase64!=='string')fail('retained_state_source');const entry=decodeFreshEvidence(Buffer.from(row.originalPayloadBase64,'base64'));validateFreshReceipt(entry.receipt,entry.transaction,row.header);if(!same([entry.transaction,entry.receipt],[row.entry.transaction,row.entry.receipt]))fail('retained_body_source');for(const call of entry.stateEvidence?.calls??[])add(entry.receipt.blockHash,call.to,call.data,call.result);}
  else if(Array.isArray(source.wire)&&source.wire.length<=160){const wire=source.wire.map((r:any)=>{if(r.status!==200||typeof r.responseBody!=='string')return null;if(r.responseSha256&&wpcSha(r.responseBody)!==r.responseSha256)fail('state_rpc_checksum');const reply=JSON.parse(r.responseBody);if(reply.jsonrpc!=='2.0'||reply.id!==r.request?.id)fail('state_rpc_identity');return reply.error||reply.result==null?null:{request:r.request,result:reply.result};});
   for(let i=0;i<wire.length;i++){const r=wire[i];if(!r||r.request.method!=='eth_call')continue;const[call,tag]=r.request.params??[];if(!call||typeof call.to!=='string'||typeof call.data!=='string')fail('state_rpc_call');
    const matches=(w:any)=>w&&w.request.method==='eth_getBlockByNumber'&&(typeof tag==='string'?w.result.number===tag:w.result.hash===tag?.blockHash);
    const before=wire.slice(0,i).reverse().find(matches),after=wire.slice(i+1).find(matches);if(!before||!after||!same(h(before.result),h(after.result)))fail('state_rpc_bookends');
    add(before.result.hash,call.to,call.data,String(r.result));
   }
  }else fail('state_source_format');
 }
 for(const{entry}of bundle.data.entries)for(const call of entry.stateEvidence?.calls??[])if(reads.get(entry.receipt.blockHash+':'+call.to+':'+call.data)!==call.result)fail('unproven_state_read');
 return{verifiedCalls:bundle.data.entries.reduce((v,e)=>v+(e.entry.stateEvidence?.calls.length??0),0),uniqueCalls:reads.size};
}

export interface WpcCanonical{sha256:string;headers:FreshBlock[];contexts:number;captureRevision?:string}
export async function verifyWpcRecoveryCanonical(bundle:WpcRecoveryBundle,rpc:Rpc,options:{captureRevision?:string}={}):Promise<WpcCanonical>{
 if(await rpc<string>('eth_chainId',[])!=='0x38')fail('node_chain');const headers=new Map<number,FreshBlock>(),all=[...bundle.data.entries,{entry:bundle.data.creation.entry,header:bundle.data.creation.block}];
 const originals=[...all.map(x=>x.header),bundle.data.creation.parent];for(const original of originals){const number=n(original.number);if(headers.has(number)){if(headers.get(number)!.hash!==original.hash)fail('header_collision');continue;}const actual=await rpc<FreshBlock>('eth_getBlockByNumber',[original.number,false]);if(!actual||!same(h(actual),h(original)))fail('canonical_header');headers.set(number,actual);}
 const txFields=['hash','from','to','input','value','gas','gasPrice','nonce','type','chainId','maxFeePerGas','maxPriorityFeePerGas','accessList','authorizationList','r','s','v','yParity','blockHash','blockNumber','transactionIndex'];
 for(const{entry,header}of all){const actual=headers.get(n(header.number))!,member=actual.transactions[n(entry.transaction.transactionIndex)]as any;if((typeof member==='string'?member:member?.hash)!==entry.transaction.hash)fail('canonical_membership');
  const tx=await rpc<any>('eth_getTransactionByHash',[entry.transaction.hash]),receipt=await rpc<any>('eth_getTransactionReceipt',[entry.transaction.hash]);if(!tx||!receipt)fail('canonical_context_missing');for(const key of txFields)if(entry.transaction[key]!==undefined&&!same(entry.transaction[key],tx[key]))fail('transaction_changed:'+key);
  for(const key of['transactionHash','transactionIndex','blockHash','blockNumber','status','gasUsed','effectiveGasPrice','contractAddress','logs'])if(entry.receipt[key]!==undefined&&!same(entry.receipt[key],receipt[key]))fail('receipt_changed:'+key);
 }
 for(const old of headers.values()){const current=await rpc<FreshBlock>('eth_getBlockByNumber',[old.number,false]);if(!current||!same(h(current),h(old)))fail('canonical_reorg');}
 const inventory=await rpc<FreshBlock>('eth_getBlockByNumber',['0x'+bundle.data.inventoryThrough.number.toString(16),false]);if(inventory?.hash!==bundle.data.inventoryThrough.hash)fail('inventory_watermark_orphaned');
 const list=[...headers.values()].sort((a,b)=>n(a.number)-n(b.number));return{sha256:wpcSha({headers:list.map(h),captureRevision:options.captureRevision??null}),headers:list,contexts:all.length,captureRevision:options.captureRevision};
}
export interface WpcMarketMark{eventId:string;marketCapUsd:string;value:Record<string,unknown>}
export async function prepareWpcRecovery(bundle:WpcRecoveryBundle,canonical:WpcCanonical){
 const{data}=bundle,proof=data.creation;if(!same(proof.start,WPC_RECOVERY_START)||proof.mode!=='internal_creation')fail('birth_scope');verifyCreationTrace(bundle);verifyWpcRecoveryStateSources(bundle);
 const headers=new Map(canonical.headers.map(b=>[n(b.number),h(b)])),fact=await validateFreshTokenCreationProof(proof,WPC_RECOVERY_START,async number=>headers.get(number)??null,async(token,block)=>wpcBirthCodeFromArchive(bundle,token,block));if(!fact||fact.status!=='eligible'||fact.tokenAddress!==WPC_RECOVERY_TOKEN)fail('birth_proof');
 const identity=data.identity,quote=identity.poolKey.currency0===WPC_RECOVERY_TOKEN?identity.poolKey.currency1:identity.poolKey.currency0;
 if(!validFreshStockwaveMarketIdentity(identity)||identity.tokenAddress!==WPC_RECOVERY_TOKEN||identity.quoteAddress!==WBNB||!same(authenticateFreshStockwavePoolInitialization(proof.entry.receipt,WPC_RECOVERY_TOKEN,identity.poolId,quote,identity.initial.tick),identity))fail('market_identity');
 const prepared:{entry:FreshCapturedReceipt;header:FreshBlock;decoded:FreshDecodedReceipt;marks:WpcMarketMark[]}[]=[];
 for(const{entry,header}of [...data.entries].sort((a,b)=>n(a.header.number)-n(b.header.number)||n(a.entry.transaction.transactionIndex)-n(b.entry.transaction.transactionIndex))){
  const block=priceBlock(header),state=createFreshStateEvidenceRpc(noWire,block,entry.stateEvidence);if(state.rejectedPrior)fail('raw_state');
  const decoded=await normalizeFreshReceipt(entry,header,{tokenDiscovery:async token=>token===WPC_RECOVERY_TOKEN?'eligible':'excluded',knownLaunch:async token=>token===WPC_RECOVERY_TOKEN,eligible:async token=>token.address===WPC_RECOVERY_TOKEN,
   metadata:async token=>{try{return await freshTokenMetadata(token,{rpc:state.rpc,block,requireSupply:false});}catch{return null;}},priceUsd:async token=>{try{return await freshQuoteUsd(token,{rpc:state.rpc,block});}catch{return null;}}});await state.settle();
  if(decoded.reasons.length||!decoded.events.length||decoded.events.some(e=>e.tokenAddress!==WPC_RECOVERY_TOKEN||!data.publicWallets.includes(e.walletAddress)))fail('normalization:'+entry.transaction.hash+':'+decoded.reasons.join(','));
  const marks:WpcMarketMark[]=[];for(const event of decoded.events.filter(e=>e.kind==='buy'||e.kind==='sell')){
   const swaps=entry.receipt.logs.filter(l=>l.address===identity.manager&&l.topics[0]===stockwavePoolManagerInterface.getEvent('Swap')!.topicHash&&l.topics[1]===identity.poolId);if(swaps.length!==1)fail('trade_market_ambiguous');
   const parsed=stockwavePoolManagerInterface.parseLog(swaps[0]);if(!parsed)fail('swap_decode');const encoded=stockwavePoolManagerInterface.encodeEventLog(parsed!.fragment,parsed!.args);if(encoded.data!==swaps[0].data||!same(encoded.topics,swaps[0].topics))fail('swap_encoding');
   const metadata=await freshTokenMetadata(WPC_RECOVERY_TOKEN,{rpc:state.rpc,block,requireSupply:true}),bnb=await freshQuoteUsd(WBNB,{rpc:state.rpc,block}),ratio=freshStockwaveRawQuoteRatio(identity,BigInt(parsed!.args.sqrtPriceX96));
   if(!metadata.supplyRaw||BigInt(metadata.supplyRaw)<=0n)fail('dated_supply');const cap=new FreshRational(BigInt(ratio.numerator)*BigInt(metadata.supplyRaw),BigInt(ratio.denominator)*10n**18n).mul(FreshRational.parse(bnb)).decimal();
   marks.push({eventId:event.id,marketCapUsd:cap,value:{version:1,kind:'post_trade_uniswap_v4_sqrt_price',source:'node',tokenAddress:WPC_RECOVERY_TOKEN,transactionHash:event.transactionHash,blockNumber:event.blockNumber,blockHash:event.blockHash,observedAt:event.occurredAt,poolId:identity.poolId,manager:identity.manager,swapLogIndex:n(swaps[0].logIndex),sqrtPriceX96:String(parsed!.args.sqrtPriceX96),supplyRaw:metadata.supplyRaw,tokenDecimals:metadata.decimals,bnbPriceUsd:bnb,marketCapUsd:cap,stateEvidenceSha256:wpcSha(entry.stateEvidence)}});
  }
  prepared.push({entry,header,decoded,marks});
 }
 const events=prepared.flatMap(w=>w.decoded.events),counts={receipts:prepared.length,events:events.length,trades:events.filter(e=>e.kind==='buy'||e.kind==='sell').length,marks:prepared.reduce((v,w)=>v+w.marks.length,0)};
 if(!same(counts,bundle.manifest.expected)||new Set(events.map(e=>e.id)).size!==events.length)fail('counts');return{fact,identity,prepared,events,counts};
}
type Prepared=Awaited<ReturnType<typeof prepareWpcRecovery>>;
async function wpcSnapshot(client:PoolClient,bundle:WpcRecoveryBundle){
 const start=(await client.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start'")).rows[0];if(start?.block_number!==String(WPC_RECOVERY_START.number)||start.block_hash!==WPC_RECOVERY_START.hash)fail('boundary_changed');
 const capture=(await client.query("SELECT revision::text FROM fresh.checkpoints WHERE key='capture'")).rows[0];if(!capture)fail('capture_missing');
 const watermark=(await client.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[bundle.data.inventoryThrough.number])).rows[0];if(watermark&&watermark.block_hash!==bundle.data.inventoryThrough.hash)fail('inventory_watermark_orphaned');
 const txs=[...bundle.data.entries.map(x=>x.entry.transaction.hash),bundle.data.creation.entry.transaction.hash],wallets=bundle.data.publicWallets;
 const tail=(await client.query(`SELECT e.tx_hash,e.block_hash,e.payload FROM fresh.recent_evidence e JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE e.block_number>$1 ORDER BY e.block_number,e.transaction_index LIMIT 4097`,[bundle.data.inventoryThrough.number])).rows;
 if(tail.length>4096)fail('inventory_refresh_required');let tailBytes=0;for(const r of tail){tailBytes+=r.payload.length;if(tailBytes>64*1024*1024)fail('inventory_budget');const e=decodeFreshEvidence(r.payload);if((e.transaction.to===WPC_RECOVERY_TOKEN||e.receipt.logs.some(l=>l.address===WPC_RECOVERY_TOKEN))&&!txs.includes(r.tx_hash))fail('new_wpc_context_requires_review:'+r.tx_hash);}
 const roles=(await client.query(`SELECT k.wallet_address,k.is_tracked,w.active,w.monitoring_from_block::text,w.monitoring_to_block::text,s.id,s.starts_block::text,s.starts_at FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address JOIN fresh.accounting_scopes s ON s.id='kol:'||w.address AND s.kind='kol' AND s.account_id IS NULL AND s.active AND s.wallet_addresses=ARRAY[w.address]::text[] WHERE k.wallet_address=ANY($1::text[]) ORDER BY k.wallet_address`,[wallets])).rows;
 if(roles.length!==wallets.length||roles.some(r=>!r.active||!r.is_tracked))fail('public_membership');for(const w of bundle.data.entries)for(const address of w.entry.wallets){const role=roles.find(r=>r.wallet_address===address);if(!role||n(w.header.number)<Math.max(Number(role.monitoring_from_block),Number(role.starts_block))||role.monitoring_to_block!=null&&n(w.header.number)>Number(role.monitoring_to_block)||Date.parse(h(w.header).timestamp)<new Date(role.starts_at).getTime())fail('public_event_boundary');}
 const facts=(await client.query('SELECT * FROM fresh.financial_events WHERE transaction_hash=ANY($1::text[]) ORDER BY id',[txs])).rows;
 const receipts=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=ANY($1::text[]) ORDER BY tx_hash,block_hash',[txs])).rows;
 const scopes=(await client.query('SELECT id,kind,account_id,wallet_addresses,starts_block::text,starts_at,revision::text,correction_epoch::text FROM fresh.accounting_scopes WHERE active AND wallet_addresses&&$1::text[] ORDER BY id',[wallets])).rows;
 const memberships=(await client.query('SELECT * FROM public.journal_wallets WHERE wallet_address=ANY($1::text[]) ORDER BY user_id,wallet_address',[wallets])).rows;
 const launch=(await client.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1',[WPC_RECOVERY_TOKEN])).rows;
 const markets=(await client.query('SELECT * FROM fresh.markets WHERE token_address=$1 ORDER BY id',[WPC_RECOVERY_TOKEN])).rows;
 const core={start,captureRevision:String(capture.revision),watermark:watermark?.block_hash??null,roles,facts,receipts,scopes,memberships,launch,markets};return{...core,sha256:wpcSha(core)};
}
export async function planWpcRecovery(client:PoolClient,bundle:WpcRecoveryBundle,canonical:WpcCanonical,operatorSha:string){
 if(!/^[a-f0-9]{64}$/.test(operatorSha))fail('operator_sha');const before=await wpcSnapshot(client,bundle);if(canonical.captureRevision!==undefined&&canonical.captureRevision!==before.captureRevision)fail('capture_changed_during_verification');const prepared=await prepareWpcRecovery(bundle,canonical),changes:{id:string;fields:string[]}[]=[];
 const old=new Map(before.facts.map(r=>[r.id,r]));for(const w of prepared.prepared)for(let i=0;i<w.decoded.events.length;i++){const event=w.decoded.events[i],prior=old.get(event.id);if(!prior)changes.push({id:event.id,fields:['new']});else{const next=preserveGangImportFact(freshEventFromRow(prior),event),fields=Object.keys(next).filter(k=>!same((next as any)[k],(freshEventFromRow(prior)as any)[k]));if(fields.length)changes.push({id:event.id,fields});w.decoded.events[i]=next;}}
 for(const w of[...prepared.prepared,{entry:bundle.data.creation.entry,header:bundle.data.creation.block}]){const sameTx=before.receipts.filter(r=>r.tx_hash===w.entry.transaction.hash);if(sameTx.some(r=>r.block_hash!==w.header.hash))fail('orphan_receipt');if(sameTx.length)mergeWpcRecoveryEvidence(decodeFreshEvidence(sameTx[0].payload),w.entry,bundle);}
 if(before.launch.length&&!same(before.launch[0].proof,prepared.fact.proof)||before.launch.some(r=>r.status!==prepared.fact.status||r.block_hash!==prepared.fact.blockHash||r.tx_hash!==prepared.fact.txHash))fail('existing_launch_conflict');
 for(const market of before.markets)if(market.id==='uniswap_v4:'+prepared.identity.manager+':'+prepared.identity.poolId&&!same(market.identity,prepared.identity))fail('existing_market_conflict');
 const events=prepared.prepared.flatMap(w=>w.decoded.events),overlap=before.facts.filter(r=>r.kind==='fee'&&r.canonical&&r.token_address!==WPC_RECOVERY_TOKEN&&events.some(e=>e.kind!=='fee'&&e.feeKey&&e.feeKey===r.fee_key));if(overlap.length)fail('known_fee_overlap_requires_review');
 for(const w of prepared.prepared)for(const mark of w.marks){const prior=old.get(mark.eventId);if(prior?.market_cap_usd!=null&&prior.market_cap_usd!==mark.marketCapUsd)fail('existing_market_cap_conflict');}
 const affected=changes.length?(await client.query(`SELECT DISTINCT s.id,s.account_id FROM fresh.accounting_scopes s JOIN jsonb_to_recordset($1::jsonb)e(wallet_address text,token_address text,block_number bigint,occurred_at timestamptz) ON e.wallet_address=ANY(s.wallet_addresses)
 WHERE s.active AND ${freshScopeEventSql('e','s')} AND(s.account_id IS NULL OR EXISTS(SELECT 1 FROM public.journal_wallets j WHERE j.user_id::text=s.account_id AND j.wallet_address=e.wallet_address AND e.block_number>=COALESCE(j.registration_block,s.starts_block) AND e.occurred_at>=j.activity_from)) ORDER BY s.id`,[JSON.stringify(events.filter(e=>changes.some(c=>c.id===e.id)).map(e=>({wallet_address:e.walletAddress,token_address:e.tokenAddress,block_number:e.blockNumber,occurred_at:e.occurredAt})))])).rows:[];
 const core={version:1,kind:'wpc_recovery_plan_v1',manifestSha256:bundle.manifestSha,operatorSha256:operatorSha,canonicalSha256:canonical.sha256,baselineSha256:before.sha256,normalizedSha256:wpcSha(prepared.prepared.map(w=>({events:w.decoded.events,marks:w.marks}))),counts:prepared.counts,changes,publicBooks:affected.filter(r=>r.account_id===null).length,privateBooks:affected.filter(r=>r.account_id!==null).length,affectedScopesSha256:wpcSha(affected.map(r=>r.id))};
 return{plan:{...core,digest:wpcSha(core)},before,prepared,scopeIds:affected.map(r=>r.id as string)};
}
async function publicSettings(client:PoolClient){const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows,result=[];for(const{tablename}of tables){if(!/^[a-z_][a-z0-9_]*$/.test(tablename))fail('table_identifier');result.push({table:tablename,...(await client.query(`SELECT count(*)::int n,md5(coalesce(string_agg(to_jsonb(r)::text,E'\n' ORDER BY to_jsonb(r)::text),'')) digest FROM public.${tablename} r`)).rows[0]});}return result;}
export async function applyWpcRecovery(client:PoolClient,bundle:WpcRecoveryBundle,canonical:WpcCanonical,operatorSha:string,planDigest:string,now=new Date()){
 await client.query('SELECT pg_advisory_xact_lock(73621941)');await client.query('SELECT pg_advisory_xact_lock(73621943)');await client.query("SELECT key FROM fresh.checkpoints WHERE key='capture' FOR UPDATE");
 const work=await planWpcRecovery(client,bundle,canonical,operatorSha);if(work.plan.digest!==planDigest)fail('plan_changed');const{before,prepared}=work;
 for(const id of before.scopes.map(s=>s.id).sort())await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fresh-scope:'+id]);
 await client.query('SELECT k.wallet_address FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address JOIN fresh.accounting_scopes s ON s.id=\'kol:\'||w.address WHERE k.wallet_address=ANY($1::text[]) ORDER BY k.wallet_address FOR SHARE OF k,w,s',[bundle.data.publicWallets]);
 await client.query('SELECT id FROM fresh.accounting_scopes WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[before.scopes.map(s=>s.id)]);await client.query('SELECT wallet_address FROM public.journal_wallets WHERE wallet_address=ANY($1::text[]) ORDER BY user_id,wallet_address FOR SHARE',[bundle.data.publicWallets]);
 if((await wpcSnapshot(client,bundle)).sha256!==before.sha256)fail('locked_context_changed');
 const settings=await publicSettings(client),allFacts=(await client.query('SELECT * FROM fresh.financial_events ORDER BY id')).rows,allReceipts=(await client.query('SELECT tx_hash,block_hash,md5(payload) AS payload_sha,expires_at FROM fresh.recent_evidence ORDER BY tx_hash,block_hash')).rows;
 for(const b of canonical.headers){const old=(await client.query('SELECT * FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[n(b.number)])).rows[0];if(old&&(old.block_hash!==b.hash||old.parent_hash!==b.parentHash||new Date(old.occurred_at).toISOString()!==h(b).timestamp))fail('stored_header_conflict');await client.query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at)VALUES($1,$2,$3,$4)ON CONFLICT(block_number)DO NOTHING',[n(b.number),b.hash,b.parentHash,h(b).timestamp]);}
 const fact=prepared.fact;await client.query('INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,log_index,launched_at,proof,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)ON CONFLICT(token_address)DO NOTHING',[fact.tokenAddress,fact.protocol,fact.blockNumber,fact.blockHash,fact.txHash,fact.logIndex,fact.launchedAt,JSON.stringify(fact.proof),fact.status]);
 const changed=new Set(work.plan.changes.map(c=>c.id)),aggregate:FreshDecodedReceipt={events:prepared.prepared.flatMap(w=>w.decoded.events).filter(e=>changed.has(e.id)),tokens:prepared.prepared.flatMap(w=>w.decoded.tokens).sort((a,b)=>a.block.number-b.block.number).slice(-1),reasons:[],executions:prepared.prepared.reduce((v,w)=>v+w.decoded.executions,0)};
 if(aggregate.events.length)await persistFreshDecodedReceipt(client,aggregate,now,prepared.prepared.map(w=>({...w.decoded,tradeBnbPrices:undefined,gangMarketMarks:undefined})),work.scopeIds);
 for(const w of prepared.prepared)for(const[id,rate]of Object.entries(w.decoded.tradeBnbPrices??{})){const event=w.decoded.events.find(e=>e.id===id);if(!event)fail('display_event');await persistFreshTradeBnbPrice(client,event!,rate);}
 const newIds=work.plan.changes.filter(c=>c.fields.includes('new')).map(c=>c.id);if(newIds.length)await client.query('UPDATE fresh.financial_events SET observed_live=false,telegram_notification_processed=true WHERE id=ANY($1::text[])',[newIds]);
 let mergedReceipts=0,newReceipts=0;for(const w of[...prepared.prepared,{entry:bundle.data.creation.entry,header:bundle.data.creation.block}]){const old=(await client.query('SELECT * FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 FOR UPDATE',[w.entry.transaction.hash,w.header.hash])).rows[0];
  if(old){const prior=decodeFreshEvidence(old.payload),next=mergeWpcRecoveryEvidence(prior,w.entry,bundle);if(!same(prior,next)){await client.query('UPDATE fresh.recent_evidence SET payload=$3,wallet_addresses=$4 WHERE tx_hash=$1 AND block_hash=$2',[w.entry.transaction.hash,w.header.hash,encodeFreshEvidence(next),next.wallets]);mergedReceipts++;}}
  else{if(w.entry.completeTraceProof&&(!w.entry.trace||!validFreshCompleteCallTrace(w.entry,validateFreshTrace(w.entry.trace))))fail('new_trace_attestation_invalid');await client.query(`INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,decoder_version,expires_at,created_at)VALUES($1,$2,$3,$4,$5,$6,'done',$7,$8,$9)`,[w.entry.transaction.hash,w.header.hash,n(w.header.number),n(w.entry.transaction.transactionIndex),encodeFreshEvidence(w.entry),w.entry.wallets,FRESH_DECODER_VERSION,new Date(Date.parse(w.entry.observedAt)+72*3600_000),w.entry.observedAt]);newReceipts++;}
 }
 for(const w of prepared.prepared){for(const mark of w.marks)await client.query('UPDATE fresh.financial_events SET market_cap_usd=COALESCE(market_cap_usd,$2),market_mark=COALESCE(market_mark,$3::jsonb) WHERE id=$1 AND canonical AND(market_cap_usd IS NULL OR market_mark IS NULL)',[mark.eventId,mark.marketCapUsd,JSON.stringify(mark.value)]);
  await client.query("UPDATE fresh.recent_evidence SET decoder_status='done',decoder_version=$3 WHERE tx_hash=$1 AND block_hash=$2 AND(decoder_status<>'done' OR decoder_version<>$3)",[w.entry.transaction.hash,w.header.hash,FRESH_DECODER_VERSION]);
 }
 const identity=prepared.identity;await client.query("INSERT INTO fresh.markets(id,token_address,address,protocol,quote_address,identity,status)VALUES($1,$2,NULL,'uniswap_v4',$3,$4::jsonb,'pending')ON CONFLICT(id)DO NOTHING",['uniswap_v4:'+identity.manager+':'+identity.poolId,WPC_RECOVERY_TOKEN,identity.quoteAddress,JSON.stringify(identity)]);
 await client.query("UPDATE fresh.jobs SET state='done',lease_id=NULL,lease_until=NULL,last_error=NULL,progress=progress||$2::jsonb,updated_at=clock_timestamp() WHERE kind='token_discovery' AND reference=$1 AND state<>'done'",[WPC_RECOVERY_TOKEN,JSON.stringify({stage:'creation_verified',factHash:wpcSha(fact),recoveryManifestSha256:bundle.manifestSha})]);
 const afterFacts=(await client.query('SELECT * FROM fresh.financial_events ORDER BY id')).rows,byId=new Map(afterFacts.map(r=>[r.id,r]));
 for(const previous of allFacts){const next=byId.get(previous.id);if(!next)fail('original_fact_removed');for(const[key,value]of Object.entries(previous))if(value!=null&&!same(value,next[key]))fail('original_known_fact_changed:'+previous.id+':'+key);}
 const afterReceipts=(await client.query('SELECT tx_hash,block_hash,md5(payload) AS payload_sha,expires_at FROM fresh.recent_evidence ORDER BY tx_hash,block_hash')).rows,byReceipt=new Map(afterReceipts.map(r=>[r.tx_hash+':'+r.block_hash,r]));
 for(const previous of allReceipts){const next=byReceipt.get(previous.tx_hash+':'+previous.block_hash);if(!next||!same(previous.expires_at,next.expires_at))fail('original_receipt_removed_or_ttl_changed');if(previous.payload_sha!==next.payload_sha&&!before.receipts.some(r=>r.tx_hash===previous.tx_hash&&r.block_hash===previous.block_hash))fail('unrelated_receipt_changed');}
 const afterSelected=(await client.query('SELECT tx_hash,block_hash,payload FROM fresh.recent_evidence WHERE tx_hash=ANY($1::text[])',[before.receipts.map(r=>r.tx_hash)])).rows;
 for(const old of before.receipts){const found=afterSelected.find(r=>r.tx_hash===old.tx_hash&&r.block_hash===old.block_hash);if(!found)fail('selected_receipt_removed');const a=decodeFreshEvidence(old.payload),b=decodeFreshEvidence(found.payload);
  if(!same([a.transaction,a.receipt],[b.transaction,b.receipt])||a.observedAt!==b.observedAt)fail('original_receipt_core_changed');
  for(const key of['decodeDiagnostics','recoveryEvidence','trace','completeTraceProof']as const)if(a[key]!=null&&!same(a[key],b[key]))fail('original_receipt_proof_changed:'+key);
  if(b.completeTraceProof&&(!b.trace||!validFreshCompleteCallTrace(b,validateFreshTrace(b.trace))))fail('retained_trace_attestation_invalid');
  for(const call of a.stateEvidence?.calls??[])if(!b.stateEvidence?.calls.some(c=>same(c,call)))fail('original_raw_state_lost');
 }
 if(!same(settings,await publicSettings(client))||!same(before.start,(await wpcSnapshot(client,bundle)).start))fail('settings_or_boundary_changed');
 const audit={version:1,kind:'wpc_recovery_audit_v1',manifestSha256:bundle.manifestSha,operatorSha256:operatorSha,planDigest:work.plan.digest,canonicalSha256:canonical.sha256,at:now.toISOString(),counts:prepared.counts,newFacts:newIds.length,originalFacts:allFacts.length,originalReceiptBodies:allReceipts.length,originalReceiptCoresExact:true,originalRawStatePreserved:true,settingsExact:true,realMessages:0};
 await client.query('INSERT INTO fresh.checkpoints(key,value)VALUES($1,$2::jsonb)ON CONFLICT(key)DO NOTHING',['wpc_recovery:'+bundle.manifestSha,JSON.stringify(audit)]);return{...audit,mergedReceipts,newReceipts,financialBatches:aggregate.events.length?1:0,publicBooks:work.plan.publicBooks,privateBooks:work.plan.privateBooks};
}
export async function runWpcRecovery(pool:Pool,bundle:WpcRecoveryBundle,canonical:WpcCanonical,operatorSha:string,options:{apply?:boolean;planDigest?:string}){const client=await pool.connect();try{await client.query(options.apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='90s'");await client.query("SET LOCAL lock_timeout='5s'");if((await client.query('SELECT current_database() name')).rows[0]?.name!=='kollens_fresh_v14')fail('production_database_required');
 const result=options.apply?await applyWpcRecovery(client,bundle,canonical,operatorSha,options.planDigest??fail('apply_digest_required')):{readOnly:true,plan:(await planWpcRecovery(client,bundle,canonical,operatorSha)).plan};await client.query(options.apply?'COMMIT':'ROLLBACK');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
