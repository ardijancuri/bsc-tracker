import {it,expect} from 'vitest';
import {certifyFreshCompleteCallTrace,validFreshCompleteCallTrace} from './passiveIncoming.js';
import {decodeFreshEvidence,encodeFreshEvidence,freshInteger,freshAddress} from './capture.js';
import {freshTraceMatchesTransaction,validateFreshTrace} from './trace.js';
// @ts-expect-error The operator-only JavaScript module has no declaration file.
import {applyHistoricalTrace,historicalTraceCandidatesSql,EXPECTED_SOURCE,EXPECTED_BOUNDARY,EXPECTED_BOUNDARY_HASH} from '../../scripts/fresh/recover-historical-traces.mjs';
const h=(c:string)=>'0x'+c.repeat(64),a=(c:string)=>'0x'+c.repeat(40);
function fixture(){
 const at='2026-10-24T19:00:00.000Z',blockHash=h('1'),txHash=h('2'),number=129568569,n='0x'+number.toString(16),wallet=a('a');
 const transaction={hash:txHash,blockHash,blockNumber:n,transactionIndex:'0x0',from:a('b'),to:a('c'),value:'0x0',input:'0x12345678',gasPrice:'0x1',type:'0x2'};
 const receipt={transactionHash:txHash,transactionIndex:'0x0',blockHash,blockNumber:n,from:transaction.from,to:transaction.to,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[]};
 const entry:any={transaction,receipt,wallets:[wallet],observedAt:at,stateEvidence:{version:1,blockNumber:number,blockHash,calls:[]},decodeDiagnostics:{firstFailure:{at,reasons:['incoming_transfer_cost_unknown']}}};
 const block={number:n,hash:blockHash,parentHash:h('3'),timestamp:'0x'+Math.floor(Date.parse(at)/1000).toString(16),transactions:[txHash]};
 const raw={type:'CALL',from:transaction.from,to:transaction.to,value:'0x0',input:transaction.input,gas:'0x10000',gasUsed:receipt.gasUsed,output:'0x',calls:[]};
 const traceRequest={method:'debug_traceTransaction',params:[txHash,{tracer:'callTracer',timeout:'3s',reexec:0,tracerConfig:{onlyTopCall:false,withLog:false}}]};
 const bracket={transaction,receipt,block},recovered:any={raw,before:structuredClone(bracket),after:structuredClone(bracket),traceRequest};
 const boundary={block_number:String(EXPECTED_BOUNDARY),block_hash:EXPECTED_BOUNDARY_HASH,value:{startBlock:EXPECTED_BOUNDARY}};
 const selected={tx_hash:txHash,block_hash:blockHash,block_number:String(number),transaction_index:0,parent_hash:block.parentHash,occurred_at:new Date(at),public_wallets:[wallet],wallet_addresses:[wallet],expires_at:new Date(Date.now()+60_000),payload:encodeFreshEvidence(entry)};
 const book={active:true,startsBlock:number,startsAt:new Date(at),member:true};
 const queries:{sql:string;params:any[]}[]=[],client={release(){},async query(sql:string,params:any[]=[]):Promise<any>{queries.push({sql,params});if(sql.includes("WHERE key='start'"))return{rows:[boundary]};if(sql.startsWith('SELECT block_hash,parent_hash'))return{rows:[{block_hash:blockHash,parent_hash:block.parentHash,occurred_at:new Date(at)}]};if(sql.startsWith('SELECT payload,wallet_addresses'))return{rows:[{payload:selected.payload,wallet_addresses:[wallet],decoder_status:'repair',expires_at:selected.expires_at}]};if(sql.startsWith('SELECT k.wallet_address')){expect(sql).toContain("s.id='kol:'||k.wallet_address");expect(sql).toContain("s.kind='kol' AND s.active");expect(sql).toContain('k.wallet_address=ANY(s.wallet_addresses)');expect(sql).toContain('s.starts_block<=$2 AND s.starts_at<=$3::timestamptz');expect(sql).toContain('FOR SHARE OF k,w,s');expect(params[2]).toEqual(selected.occurred_at);return{rows:book.active&&book.member&&book.startsBlock<=Number(params[1])&&+book.startsAt<=+new Date(params[2])?[{wallet_address:wallet}]:[]};}return{rows:[],rowCount:1};}};
 const validators={decodeFreshEvidence,encodeFreshEvidence,freshInteger,freshAddress,validateFreshTrace,freshTraceMatchesTransaction,certifyFreshCompleteCallTrace,validateFreshReceipt(){}};
 return{entry,recovered,boundary,selected,queries,validators,book,db:{connect:async()=>client}};
}
it('actual trusted archive apply persists full-request attestation only with original canonical bookends',async()=>{
 const f=fixture();expect(await applyHistoricalTrace(f.db,f.selected,f.recovered,{version:1},f.validators,async()=>EXPECTED_SOURCE,f.boundary)).toBe(true);
 const update=f.queries.find(q=>q.sql.startsWith('UPDATE fresh.recent_evidence'))!;const saved=decodeFreshEvidence(update.params[2]);
 expect(saved.completeTraceProof?.source).toBe('operator_archive');expect(validFreshCompleteCallTrace(saved,validateFreshTrace(saved.trace))).toBe(true);
 expect(saved.receipt).toEqual(f.entry.receipt);expect(saved.stateEvidence).toEqual(f.entry.stateEvidence);expect(saved.decodeDiagnostics).toEqual(f.entry.decodeDiagnostics);
 expect(f.queries.some(q=>/UPDATE fresh\.(financial_events|positions|kols)/.test(q.sql))).toBe(false);
});
for(const [name,change]of[
 ['absent original request',(f:any)=>delete f.recovered.traceRequest],
 ['top-call-only request',(f:any)=>f.recovered.traceRequest.params[1].tracerConfig.onlyTopCall=true],
 ['changed after receipt',(f:any)=>f.recovered.after.receipt.gasUsed='0x1'],
 ['foreign signed input',(f:any)=>{f.recovered.before.transaction.input='0x00';f.recovered.after.transaction.input='0x00';}],
 ['foreign complete trace input',(f:any)=>f.recovered.raw.input='0x00'],
]as const)it('archive apply rejects '+name+' before payload write',async()=>{
 const f=fixture();change(f);await expect(applyHistoricalTrace(f.db,f.selected,f.recovered,{version:1},f.validators,async()=>EXPECTED_SOURCE,f.boundary)).rejects.toThrow();expect(f.queries.some(q=>q.sql.startsWith('UPDATE fresh.recent_evidence'))).toBe(false);expect(f.queries.some(q=>q.sql==='ROLLBACK')).toBe(true);
});

it('both external selection predicates require active own-book membership and exact start boundaries',()=>{expect(historicalTraceCandidatesSql.match(/s.kind='kol' AND s.active/g)?.length).toBe(2);expect(historicalTraceCandidatesSql.match(/s.starts_block<=e.block_number AND s.starts_at<=b.occurred_at/g)?.length).toBe(2);});
for(const[name,change]of[['inactive book',(f:any)=>f.book.active=false],['foreign book member',(f:any)=>f.book.member=false],['before start block',(f:any)=>f.book.startsBlock++],['before start time',(f:any)=>f.book.startsAt=new Date(+f.book.startsAt+1)]]as const)it('archive apply excludes '+name+' before attestation or payload write',async()=>{const f=fixture();change(f);await expect(applyHistoricalTrace(f.db,f.selected,f.recovered,{version:1},f.validators,async()=>EXPECTED_SOURCE,f.boundary)).rejects.toThrow('archive_wallet_changed');expect(f.queries.some(q=>q.sql.startsWith('UPDATE fresh.recent_evidence'))).toBe(false);});
