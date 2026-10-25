import { Interface } from 'ethers';
import type { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import { FreshRational } from './accounting.js';
import { freshCall,type FreshPriceBlock } from './pricing.js';
import { blockHex } from '../rpc.js';
import { freshHash,freshInteger } from './capture.js';
import {freshBalanceWorkSql,freshBalanceCommitSql} from './balanceScheduling.js';
const abi=new Interface(['function balanceOf(address) view returns(uint256)']);
const q=FreshRational.parse;
/** Confirm current quantities in place. There is no periodic balance-history table. */
export async function refreshFreshBalances(db:Pool,rpc:Rpc,limit=64) {
  const checkpoint=(await db.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='capture'")).rows[0];
  if(!checkpoint?.block_number||!freshHash(checkpoint.block_hash))return{checked:0,matched:0,mismatch:0,pending:0,block:null};
  const header=await rpc<{number:string;hash:string;timestamp:string}>('eth_getBlockByNumber',[blockHex(Number(checkpoint.block_number)),false]);
  if(!header||Number(freshInteger(header.number))!==Number(checkpoint.block_number)||header.hash?.toLowerCase()!==checkpoint.block_hash)throw new Error('balance_capture_block_changed');
  const block:FreshPriceBlock={number:Number(checkpoint.block_number),hash:checkpoint.block_hash,timestamp:new Date(Number(freshInteger(header.timestamp))*1000).toISOString()};
  const rows=(await db.query(freshBalanceWorkSql,[limit,block.number])).rows;
  const calls=new Map<string,Promise<bigint>>();let matched=0,mismatch=0,pending=0;
  for(let offset=0;offset<rows.length;offset+=4)await Promise.all(rows.slice(offset,offset+4).map(async row=>{
    try{
      if(row.decimals==null)throw new Error('token_decimals_unverified');
      if(row.wallet_gap||row.registration_pending||row.decoding_pending||row.last_event_block==null||BigInt(row.last_event_block)>BigInt(block.number))throw new Error('wallet_decoding_pending');
      const balances=await Promise.all(row.wallet_addresses.map((wallet:string)=>{const key=`${wallet}:${row.token_address}`;
        let call=calls.get(key);if(!call){call=freshCall({rpc,block},row.token_address,abi,'balanceOf',[wallet]).then(value=>BigInt(value[0]));calls.set(key,call);}return call;}));
      const quantity=new FreshRational(balances.reduce((a:bigint,b:bigint)=>a+b,0n),10n**BigInt(row.decimals));
      const equal=quantity.compare(q(row.quantity_q))===0;
      const updated=await db.query(freshBalanceCommitSql,[row.scope_id,row.token_address,quantity.decimal(255),block.number,block.hash,block.timestamp,equal?'matched':'mismatch',row.revision,row.scope_revision]);
      if(!updated.rowCount){pending++;await db.query(`UPDATE fresh.positions SET balance_status='pending' WHERE scope_id=$1 AND token_address=$2 AND revision=$3 AND balance_status IS DISTINCT FROM 'pending'`,[row.scope_id,row.token_address,row.revision]);}
      else if(equal)matched++;else mismatch++;
    }catch{pending++;await db.query(`UPDATE fresh.positions SET balance_status='pending' WHERE scope_id=$1 AND token_address=$2 AND revision=$3 AND balance_status IS DISTINCT FROM 'pending'`,[row.scope_id,row.token_address,row.revision]);}
  }));
  return{checked:rows.length,matched,mismatch,pending,block:block.number};
}
