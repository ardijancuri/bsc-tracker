import type { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import roster from '../roster.json' with {type:'json'};
import avatars from '../x-avatars.json' with {type:'json'};
import { freshConfirmedPriceBlock } from './pricing.js';

/** Establish a boundary once. This command never resets a populated database. */
export async function initializeFreshTracking(db:Pool,rpc:Rpc) {
  const existing=(await db.query(`SELECT block_number,block_hash,value FROM fresh.checkpoints WHERE key='start'`)).rows[0];
  if(existing)return{created:false,...existing};
  const confirmed=await freshConfirmedPriceBlock(rpc),client=await db.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621940)');
    const current=await client.query(`SELECT * FROM fresh.checkpoints WHERE key='start' FOR UPDATE`);
    if(current.rowCount){await client.query('ROLLBACK');return{created:false,...current.rows[0]};}
    if((await client.query(`SELECT 1 FROM fresh.financial_events LIMIT 1`)).rowCount)throw new Error('cannot_initialize_nonempty_financial_database');
    const value={startBlock:confirmed.number,startHash:confirmed.hash,startTime:confirmed.timestamp,confirmations:6};
    for(const key of ['start','capture','decode'])await client.query(`INSERT INTO fresh.checkpoints(key,block_number,block_hash,value) VALUES($1,$2,$3,$4::jsonb)`,[key,confirmed.number,confirmed.hash,JSON.stringify(value)]);
    // A boundary header allows a reorg at the very first captured block to find its parent.
    const block=await rpc<{parentHash:string}>('eth_getBlockByHash',[confirmed.hash,false]);
    if(!block?.parentHash)throw new Error('boundary_header_unavailable');
    await client.query(`INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)`,[confirmed.number,confirmed.hash,block.parentHash,confirmed.timestamp]);
    for(const identity of roster){const image=(avatars as Record<string,{avatar:string;twitter:string}>)[identity.address];
      await client.query(`INSERT INTO fresh.wallets(address,monitoring_from_block,registered_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[identity.address,confirmed.number+1,confirmed.timestamp]);
      await client.query(`INSERT INTO fresh.kols(wallet_address,display_name,twitter,avatar_url) VALUES($1,$2,$3,$4) ON CONFLICT(wallet_address) DO NOTHING`,[identity.address,identity.name,identity.twitter,image?.avatar??null]);
      await client.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,starts_at,starts_block) VALUES($1,'kol',ARRAY[$2]::text[],$3,$4) ON CONFLICT DO NOTHING`,[`kol:${identity.address}`,identity.address,confirmed.timestamp,confirmed.number+1]);
    }
    await client.query('COMMIT');return{created:true,block_number:confirmed.number,block_hash:confirmed.hash,value};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
