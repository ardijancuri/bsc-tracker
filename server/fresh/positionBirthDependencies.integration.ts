/** Exact local rollback-only SQL checks; original repairs and every persistent
 * application table remain untouched. No node/provider request is made. */
import assert from'node:assert/strict';import{Pool}from'pg';
import{freshPositionReceiptRelevantSql,freshPositionReceiptOpaqueSql}from'./positionDependencies.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_tempo_wpc_20261025_192724')throw Error('birth_dependency_owned_local_clone_only');
const pool=new Pool({connectionString:url.href,max:1}),c=await pool.connect(),checks:string[]=[];
const token='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),iso=(n:number)=>new Date(Date.UTC(2026,9,25,0,0,n)).toISOString();
const proof={version:1,kind:'canonical_token_birth_v1',creation:'internal_creation',source:'node',start:{number:100,hash:hash(100)},
 parent:{number:109,hash:hash(109),parentHash:hash(108),timestamp:iso(109)},birth:{number:110,hash:hash(110),parentHash:hash(109),timestamp:iso(110)},codeBefore:'0x',runtimeSha256:'a'.repeat(64),runtimeBytes:13095,creator:other,creationTransactionKnown:true,witnessTransactionHash:hash(900),originalContextSha256:'b'.repeat(64),creationFrame:{type:'CREATE2',creator:other,inputSha256:'c'.repeat(64),runtimeSha256:'a'.repeat(64),path:[2,0]}};
const query=(sql:string,args:unknown[]=[])=>c.query(sql.replaceAll('fresh.','pg_temp.'),args);
const relevant=async(asset=token)=>Boolean((await query(`SELECT ${freshPositionReceiptRelevantSql('e','$1')} AS relevant FROM fresh.recent_evidence e`,[asset])).rows[0].relevant);
const negative=async(name:string,change:()=>Promise<unknown>)=>{await c.query('SAVEPOINT negative');await change();assert.equal(await relevant(),true,name);await c.query('ROLLBACK TO SAVEPOINT negative');checks.push(name);};
try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='10s'");
 for(const table of['launch_facts','checkpoints','recent_blocks','recent_evidence'])await c.query(`CREATE TEMP TABLE ${table}(LIKE fresh.${table} INCLUDING ALL)ON COMMIT DROP`);
 await c.query('CREATE TEMP TABLE financial_events(canonical boolean,token_address text,transaction_hash text,block_hash text)ON COMMIT DROP');
 await query("INSERT INTO fresh.checkpoints(key,block_number,block_hash,value)VALUES('start',100,$1,$2)",[hash(100),{startBlock:100,startHash:hash(100)}]);
 for(const n of[109,110])await query('INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at)VALUES($1,$2,$3,$4)',[n,hash(n),hash(n-1),iso(n)]);
 await query("INSERT INTO fresh.launch_facts(token_address,protocol,block_number,block_hash,tx_hash,launched_at,proof,status)VALUES($1,'evm_creation',110,$2,$3,$4,$5,'eligible')",[token,hash(110),hash(900),iso(110),proof]);
 await query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,decoder_status,last_error,expires_at)VALUES($1,$2,105,0,$3,'repair','synthetic_transfer_batch_unverified',$4)",[hash(700),hash(105),Buffer.from('original opaque receipt retained'),iso(999)]);
 const original=(await query('SELECT tx_hash,block_hash,payload,decoder_status,last_error,expires_at FROM fresh.recent_evidence')).rows;
 assert.equal(await relevant(),false);assert.equal(await relevant(other),true);checks.push('Authenticated later CREATE2 birth excludes only this token from an older opaque repair');
 assert.equal((await query(`SELECT ${freshPositionReceiptOpaqueSql('e')} opaque FROM fresh.recent_evidence e`)).rows[0].opaque,true);checks.push('Wallet-wide opaque receipt and other-token accounting remain blocked');
 await negative('Same-block ordering is never inferred',()=>query('UPDATE fresh.recent_evidence SET block_number=110'));
 await negative('Later receipts remain relevant',()=>query('UPDATE fresh.recent_evidence SET block_number=111'));
 await negative('Explicit target dependency overrides a contradictory birth floor',()=>query('UPDATE fresh.recent_evidence SET position_dependency_addresses=$1,position_dependency_proof=NULL',[[token]]));
 await negative('Existing canonical target financial identity stays relevant',()=>query('INSERT INTO fresh.financial_events VALUES(true,$1,$2,$3)',[token,hash(700),hash(105)]));
 await negative('A pool-only launch protocol cannot bound token existence',()=>query("UPDATE fresh.launch_facts SET protocol='stockwave'"));
 const mutate=async(path:string,value:unknown)=>query('UPDATE fresh.launch_facts SET proof=jsonb_set(proof,$1::text[],$2::jsonb)',[path.split('.'),JSON.stringify(value)]);
 for(const[path,value]of[['kind','pool_creation'],['version',2],['source','unverified'],['codeBefore','0x6000'],['runtimeSha256','invalid'],['runtimeBytes','malformed'],['runtimeBytes',999999],['creator','invalid'],['originalContextSha256','invalid'],['creationTransactionKnown',false],['witnessTransactionHash',hash(901)],['start.hash',hash(999)],['birth.hash',hash(999)],['birth.timestamp',iso(111)],['parent.hash',hash(999)],['parent.parentHash',hash(999)],['creation','exact_state_birth'],['creationFrame.type','CALL'],['creationFrame.creator',token],['creationFrame.runtimeSha256','f'.repeat(64)],['creationFrame.inputSha256','invalid'],['creationFrame.path','ambiguous'],['creationFrame.path',[-1]],['creationFrame.path',['0']],['creationFrame.path',[]]]as const)
  await negative('Malformed/unverified creation proof remains conservative: '+path+'='+JSON.stringify(value),()=>mutate(path,value));
 await negative('Orphaned birth header remains blocking',()=>query('UPDATE fresh.recent_blocks SET block_hash=$1 WHERE block_number=110',[hash(999)]));
 await negative('Missing parent header remains blocking',()=>query('DELETE FROM fresh.recent_blocks WHERE block_number=109'));
 await negative('Changed global start remains blocking',()=>query("UPDATE fresh.checkpoints SET block_hash=$1 WHERE key='start'",[hash(999)]));
 await negative('Changed row birth identity remains blocking',()=>query('UPDATE fresh.launch_facts SET block_hash=$1',[hash(999)]));
 await negative('An excluded token never authorizes the floor',()=>query("UPDATE fresh.launch_facts SET status='excluded_non_token'"));
 await c.query('SAVEPOINT top');await mutate('creation','top_level_creation');await query("UPDATE fresh.launch_facts SET proof=proof-'creationFrame'");assert.equal(await relevant(),false);await c.query('ROLLBACK TO SAVEPOINT top');checks.push('A canonical top-level creation can use the same strict boundary');
 assert.deepEqual((await query('SELECT tx_hash,block_hash,payload,decoder_status,last_error,expires_at FROM fresh.recent_evidence')).rows,original);checks.push('Every original repair body, status, reason and expiry is unchanged');
 await c.query('ROLLBACK');console.log(JSON.stringify({passed:true,checks:checks.length,persistentWrites:0,nodeCalls:0,financialWrites:0,repairPreserved:true}));
}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();await pool.end();}
