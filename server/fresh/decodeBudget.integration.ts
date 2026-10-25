/** Bounded worker scheduling; every fixture write rolls back. No node/provider. */
import assert from'node:assert/strict';import{randomBytes,randomUUID}from'node:crypto';import{Interface}from'ethers';import{Pool}from'pg';
import{runFreshDecode}from'./decode.js';import{applyFreshFinancialEvents,FreshRational as R}from'./accounting.js';
import{encodeFreshEvidence,type FreshCapturedReceipt}from'./capture.js';import{transferTopic}from'../swap.js';
import type{FreshFinancialEvent}from'../../shared/freshAccounting.js';import type{Rpc}from'../rpc.js';
const url=new URL(process.env.DATABASE_URL??'');if(url.hostname!=='127.0.0.1'||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('isolated_database_required');
const db=new Pool({connectionString:url.href,max:1}),c=await db.connect(),address=()=>`0x${randomBytes(20).toString('hex')}`,hash=()=>`0x${randomBytes(32).toString('hex')}`;
const a=address(),b=address(),external=address(),token=address(),drop=address(),combined='budget-combined:'+a,user=randomUUID(),now=new Date(),at=new Date(Math.floor(now.getTime()/1000)*1000-60_000);
const metadata=new Interface(['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function name() view returns(string)','function symbol() view returns(string)']);
const rewrite=(sql:string)=>sql.replaceAll('fresh.recent_blocks','fresh_budget_blocks').replaceAll('fresh.recent_evidence','fresh_budget_evidence').replaceAll('fresh.jobs','fresh_budget_jobs').replaceAll('fresh.checkpoints','fresh_budget_checkpoints');
let monotonic=0,wire=0,savepoint=0,currentSavepoint='',blockAtomicChecks=0;
const pairTx=[hash(),hash()],deferredTx=hash(),freshTx=hash();
try{
 await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(73621941)');
 const start=(await c.query("SELECT block_number,value FROM fresh.checkpoints WHERE key='capture'")).rows[0],number=Number(start.block_number)+500;
 for(const[table,source]of[['fresh_budget_blocks','recent_blocks'],['fresh_budget_evidence','recent_evidence'],['fresh_budget_jobs','jobs'],['fresh_budget_checkpoints','checkpoints']])await c.query(`CREATE TEMP TABLE ${table}(LIKE fresh.${source} INCLUDING ALL) ON COMMIT DROP`);
 await c.query("INSERT INTO fresh_budget_checkpoints(key,block_number,block_hash,value) VALUES('capture',$1,$2,$3::jsonb),('decode',$1,$2,$3::jsonb)",[number+2,hash(),JSON.stringify({startBlock:start.value.startBlock})]);
 for(const wallet of[a,b]){
  await c.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,$2)',[wallet,number-3]);await c.query('INSERT INTO fresh.kols(wallet_address) VALUES($1)',[wallet]);
  await c.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',$2,$3,$4)",['kol:'+wallet,[wallet],new Date(at.getTime()-10_000),number-3]);
 }
 await c.query("INSERT INTO public.auth_users(id,issuer,subject,name) VALUES($1::uuid,'fixture',$1::text,'Decoder budget fixture')",[user]);
 for(const wallet of[a,b])await c.query('INSERT INTO public.journal_wallets(user_id,wallet_address,activity_from,registration_block,revision) VALUES($1,$2,$3,$4,$5)',[user,wallet,new Date(at.getTime()-10_000),number-3,randomUUID()]);
 await c.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block,account_id) VALUES($1,'portfolio_combined',$2,$3,$4,$5)",[combined,[a,b],new Date(at.getTime()-10_000),number-3,user]);
 for(const asset of[token,drop]){
  await c.query("INSERT INTO fresh.tokens(address,decimals,launch_status) VALUES($1,18,'eligible')",[asset]);
  await c.query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status) VALUES($1,'fourmeme',$2,$3,$4,$5,'{}','eligible')",[asset,number-3,hash(),hash(),at]);
 }
 const buyId=hash().slice(2),buy:FreshFinancialEvent={id:buyId,executionKey:buyId,walletAddress:a,tokenAddress:token,kind:'buy',quantity:'10',amountUsd:'100',feeUsd:'1',feeKey:buyId+':fee',counterparty:null,transferKey:null,blockNumber:String(number-2),blockHash:hash(),transactionHash:hash(),transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:new Date(at.getTime()-1000).toISOString()};
 await applyFreshFinancialEvents(c,[buy],{now});
 const financialFields='quantity_q,invested_q,sold_q,incoming_q,outgoing_q,fees_q,capital_q,realized_q,unknown_cost,unknown_fee';
 const combinedBefore=(await c.query(`SELECT ${financialFields} FROM fresh.positions WHERE scope_id=$1 AND token_address=$2`,[combined,token])).rows[0];
 assert.ok(combinedBefore,'real Portfolio memberships must qualify the seed purchase');
 assert.equal(combinedBefore.quantity_q,'10','the private combined book must begin with ten purchased units');
 assert.equal(R.fromStored(combinedBefore.capital_q).decimal(),'101','the original purchase capital includes its one-dollar fee');
 const originalLots=(await c.query('SELECT quantity_q,cost_q,wallet_address FROM fresh.open_lots WHERE scope_id=$1 AND token_address=$2',[combined,token])).rows;
 assert.equal(originalLots.reduce((q,x)=>q.add(R.fromStored(x.quantity_q)),R.parse('0')).decimal(),'10');
 assert.equal(originalLots.reduce((q,x)=>q.add(R.fromStored(x.cost_q)),R.parse('0')).decimal(),'101','the original FIFO lot must exist before any budgeted normalization');
 const headers=new Map<number,string>();
 async function receipt(tx:string,height:number,index:number,asset:string,from:string,to:string,quantity:number,status:'pending'|'repair'){
  let h=headers.get(height);if(!h){h=hash();headers.set(height,h);await c.query('INSERT INTO fresh_budget_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)',[height,h,hash(),new Date(at.getTime()+(height-number)*1000)]);}
  const blockNumber='0x'+height.toString(16),transactionIndex='0x'+index.toString(16),entry:FreshCapturedReceipt={
   transaction:{hash:tx,from:external,to:asset,value:'0x0',input:'0x',gasPrice:'0x0',blockNumber,blockHash:h,transactionIndex},
   receipt:{transactionHash:tx,blockNumber,blockHash:h,transactionIndex,status:'0x1',gasUsed:'0x1',effectiveGasPrice:'0x0',logs:[{address:asset,topics:[transferTopic,'0x'+from.slice(2).padStart(64,'0'),'0x'+to.slice(2).padStart(64,'0')],data:'0x'+(BigInt(quantity)*10n**18n).toString(16).padStart(64,'0'),blockNumber,blockHash:h,transactionHash:tx,transactionIndex,logIndex:'0x0'}]},
   wallets:[...new Set([from,to].filter(w=>w===a||w===b))],observedAt:at.toISOString()};
  const payload=encodeFreshEvidence(entry);await c.query('INSERT INTO fresh_budget_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[tx,h,height,index,payload,entry.wallets,status,new Date(now.getTime()+72*3600_000)]);
  if(status==='repair')await c.query("INSERT INTO fresh_budget_jobs(id,kind,reference,due_at,last_error,progress) VALUES($1,'decode_receipt',$2,$3,'old_retry',$4::jsonb)",['decode:'+tx,tx+':'+h,new Date(now.getTime()-1000),JSON.stringify({firstFailure:{version:1,at:at.toISOString(),reasons:['old_retry']}})]);
  return payload;
 }
 await receipt(pairTx[0],number,0,token,a,b,2,'repair');await receipt(pairTx[1],number,1,token,b,a,1,'repair');await receipt(deferredTx,number+1,0,drop,external,a,1,'repair');
 const deferredBefore=(await c.query('SELECT to_jsonb(e)::text body FROM fresh_budget_evidence e WHERE tx_hash=$1',[deferredTx])).rows[0].body;
 const jobBefore=(await c.query("SELECT to_jsonb(j)::text body FROM fresh_budget_jobs j WHERE reference LIKE $1",[deferredTx+':%'])).rows[0].body;
 const query=async(sql:string,params?:unknown[])=>{
  if(sql==='BEGIN'){currentSavepoint='decode_budget_'+(++savepoint);return c.query('SAVEPOINT '+currentSavepoint);}
  if(sql==='COMMIT'){
   const count=Number((await c.query('SELECT count(*) AS n FROM fresh.financial_events WHERE transaction_hash=ANY($1::text[]) AND canonical',[pairTx])).rows[0].n);
   assert.ok(count===0||count===4,'selected same-block receipts must commit together');if(count===4)blockAtomicChecks++;
   return c.query('RELEASE SAVEPOINT '+currentSavepoint);
  }
  if(sql==='ROLLBACK')return c.query('ROLLBACK TO SAVEPOINT '+currentSavepoint);
  return c.query(rewrite(sql),params);
 };
 const adapter={query,connect:async()=>({query,release(){}})}as unknown as Pool;
 const rpc:Rpc=async<T>(method:string,params:unknown[]):Promise<T>=>{
  wire++;monotonic+=4_000;assert.equal(method,'eth_call');const call=params[0]as{to:string;data:string};
  for(const name of['decimals','totalSupply','name','symbol']as const)if(call.data===metadata.encodeFunctionData(name))return metadata.encodeFunctionResult(name,[name==='decimals'?18:name==='totalSupply'?10n**27n:name==='name'?'Budget scheduling fixture':'BUDGET'])as T;
  throw Error('fixture_has_no_market');
 };
 const first=await runFreshDecode(adapter,rpc,{now,maxNormalizeMs:3_000,normalizationNow:()=>monotonic,limit:32});
 assert.equal(first.attemptedReceipts,2);assert.equal(first.receipts,2);assert.equal(first.deferredReceipts,1);assert.ok(blockAtomicChecks>0);
 assert.equal((await c.query('SELECT to_jsonb(e)::text body FROM fresh_budget_evidence e WHERE tx_hash=$1',[deferredTx])).rows[0].body,deferredBefore);
 assert.equal((await c.query('SELECT to_jsonb(j)::text body FROM fresh_budget_jobs j WHERE reference LIKE $1',[deferredTx+':%'])).rows[0].body,jobBefore);
 assert.equal((await c.query('SELECT count(*)::int n FROM fresh.financial_events WHERE transaction_hash=$1',[deferredTx])).rows[0].n,0);
 assert.deepEqual((await c.query(`SELECT ${financialFields} FROM fresh.positions WHERE scope_id=$1 AND token_address=$2`,[combined,token])).rows[0],combinedBefore,'internal transfers preserve original costs and create no profit');
 const lots=(await c.query('SELECT quantity_q,cost_q,wallet_address FROM fresh.open_lots WHERE scope_id=$1 AND token_address=$2',[combined,token])).rows;
 assert.equal(lots.reduce((q,x)=>q.add(R.fromStored(x.quantity_q)),R.parse('0')).decimal(),'10');assert.equal(lots.reduce((q,x)=>q.add(R.fromStored(x.cost_q)),R.parse('0')).decimal(),'101');
 await receipt(freshTx,number+2,0,drop,external,b,1,'pending');monotonic=0;
 const second=await runFreshDecode(adapter,rpc,{now,maxNormalizeMs:3_000,normalizationNow:()=>monotonic,limit:32});
 assert.equal(second.attemptedReceipts,1);assert.equal(second.deferredReceipts,1);assert.equal((await c.query('SELECT decoder_status FROM fresh_budget_evidence WHERE tx_hash=$1',[freshTx])).rows[0].decoder_status,'done');
 assert.equal((await c.query('SELECT count(*)::int n FROM fresh.financial_events WHERE transaction_hash=$1',[deferredTx])).rows[0].n,0,'fresh pending work gets the next pass');
 assert.equal((await c.query('SELECT amount_usd FROM fresh.financial_events WHERE transaction_hash=$1',[freshTx])).rows[0].amount_usd,null,'unknown acquisition costs remain unknown');
 const third=await runFreshDecode(adapter,rpc,{now,limit:32});assert.equal(third.attemptedReceipts,1);assert.equal(third.deferredReceipts,0);
 assert.equal((await c.query('SELECT decoder_status FROM fresh_budget_evidence WHERE tx_hash=$1',[deferredTx])).rows[0].decoder_status,'done');
 assert.deepEqual((await c.query(`SELECT ${financialFields} FROM fresh.positions WHERE scope_id=$1 AND token_address=$2`,[combined,token])).rows[0],combinedBefore);
 assert.equal((await c.query('SELECT quantity_q FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[combined,drop])).rows[0].quantity_q,'2');
 assert.ok(first.completeCutoffBlock!==null&&second.completeCutoffBlock!==null&&first.completeCutoffBlock<number&&second.completeCutoffBlock<number,'deferred or genuinely unresolved evidence cannot approve coverage');
 console.log(JSON.stringify({passed:true,checks:15,fixturesRolledBack:true,nodeCalls:0,providerCalls:0,fakeRpcCalls:wire,sameSelectedBlockAtomic:true,internalCostsPreserved:true,unstartedEvidenceAndJobsExact:true,newPendingBeforeOldRepair:true,unknownCostsPreserved:true}));
}finally{await c.query('ROLLBACK');c.release();await db.end();}
