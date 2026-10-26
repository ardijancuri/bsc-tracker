import assert from'node:assert/strict';
import{randomBytes}from'node:crypto';
import{Pool}from'pg';
import{freshPublicTokenDiscoveryPendingSql}from'./leaderboard.js';

// Explicit local invocation only. Every fixture is rolled back, including when
// an assertion fails; no existing account, receipt or financial row is changed.
const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'5436');
const pool=new Pool({connectionString:url.toString(),max:1}),client=await pool.connect();
try{
  await client.query('BEGIN');
  const blocks=(await client.query('SELECT block_number::text,block_hash,occurred_at FROM fresh.recent_blocks ORDER BY block_number DESC OFFSET 128 LIMIT 2')).rows;
  assert.equal(blocks.length,2);const[publicBlock,privateBlock]=blocks,wallet='0x'+randomBytes(20).toString('hex'),scope='kol:'+wallet;
  await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block)VALUES($1,$2)',[wallet,privateBlock.block_number]);
  await client.query("INSERT INTO fresh.kols(wallet_address,display_name)VALUES($1,'discovery privacy fixture')",[wallet]);
  await client.query("INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block)VALUES($1,'kol',ARRAY[$2]::text[],$3,$4)",[scope,wallet,publicBlock.occurred_at,publicBlock.block_number]);
  const add=async(block:typeof publicBlock)=>client.query("INSERT INTO fresh.recent_evidence(tx_hash,block_hash,block_number,transaction_index,payload,wallet_addresses,decoder_status,last_error,expires_at)VALUES($1,$2,$3,0,$4,ARRAY[$5]::text[],'repair','token_discovery_pending',clock_timestamp()+interval '72 hours')",['0x'+randomBytes(32).toString('hex'),block.block_hash,block.block_number,Buffer.from('rollback-only fixture'),wallet]);
  const read=async()=>Boolean((await client.query(`SELECT ${freshPublicTokenDiscoveryPendingSql()} pending FROM fresh.kols k JOIN fresh.wallets w ON w.address=k.wallet_address WHERE k.wallet_address=$3`,[new Date(new Date(privateBlock.occurred_at).getTime()-1000),new Date(new Date(publicBlock.occurred_at).getTime()+1000),wallet])).rows[0].pending);
  await add(privateBlock);assert.equal(await read(),false,'Pre-public private activity must remain private');
  await add(publicBlock);assert.equal(await read(),true,'A current public discovery repair must be visible');
  await client.query('UPDATE fresh.wallets SET monitoring_to_block=$2 WHERE address=$1',[wallet,privateBlock.block_number]);assert.equal(await read(),false,'Ended monitoring cannot leak later activity');
  await client.query('UPDATE fresh.wallets SET monitoring_to_block=NULL,active=false WHERE address=$1',[wallet]);assert.equal(await read(),false,'Inactive wallet stays outside public pending status');
  await client.query('UPDATE fresh.wallets SET active=true WHERE address=$1',[wallet]);await client.query("UPDATE fresh.accounting_scopes SET account_id='private-fixture' WHERE id=$1",[scope]);assert.equal(await read(),false,'Private accounting scope cannot authorize a public badge');
  await client.query('ROLLBACK');console.log(JSON.stringify({ok:true,checks:5,rolledBack:true,financialWrites:0,realMessages:0}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
