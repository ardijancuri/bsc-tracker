import type{Pool}from'pg';import type{Rpc}from'../rpc.js';
import{decodeFreshEvidence,encodeFreshEvidence,freshInteger,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
import type{FreshPriceBlock}from'./pricing.js';
import{freshSignedSelfCallBatch,validateFreshSelfCallContext,validateFreshSelfCallCapture,validateFreshSelfCallBlock,FRESH_SELF_CALL_DELEGATE,type FreshSelfCallExecutionContext}from'./signedSelfCallSettlement.js';
type Entry=FreshCapturedReceipt&{selfCallContext?:FreshSelfCallExecutionContext};
const identity=(e:FreshCapturedReceipt)=>JSON.stringify({transaction:e.transaction,receipt:e.receipt,wallets:e.wallets,historicalWallets:e.historicalWallets,observedAt:e.observedAt});
/** Exactly3 own-node requests: original full block and two same-hash code
 * observations. Called only under urgent_evidence's shared finite budget.
 * It never uses current state or follows an arbitrary delegate. */
export async function readFreshSelfCallContext(entry:FreshCapturedReceipt,block:FreshPriceBlock,rpc:Rpc,options:{save?:(context:FreshSelfCallExecutionContext)=>Promise<void>;signal?:AbortSignal;deadline?:number;now?:()=>number}={}):Promise<FreshSelfCallExecutionContext|null>{
 const batch=freshSignedSelfCallBatch(entry);if(!batch)return null;
 const prior=(entry as Entry).selfCallContext;if(prior&&!validateFreshSelfCallCapture(entry,block,prior))throw Error('self_call_saved_context_invalid');
 const context:FreshSelfCallExecutionContext=prior?structuredClone(prior):{version:1,kind:'signed_self_call_execution_context',status:'partial',chainId:56,transactionHash:entry.transaction.hash,blockNumber:block.number,blockHash:block.hash,codeReads:[]};
 const ready=()=>{context.status='complete';if(!validateFreshSelfCallContext(entry,block,context))context.status='partial';return context.status==='complete';},check=()=>{options.signal?.throwIfAborted();if(options.deadline!==undefined&&(options.now??Date.now)()>=options.deadline)throw Error('self_call_capture_deadline');},save=async()=>{if(!validateFreshSelfCallCapture(entry,block,context))throw Error('self_call_capture_observation_invalid');await options.save?.(structuredClone(context));};
 if(!context.block){check();const raw=await rpc<FreshBlock>('eth_getBlockByNumber',['0x'+block.number.toString(16),true]);if(!raw||Buffer.byteLength(JSON.stringify(raw))>2*1024*1024||!validateFreshSelfCallBlock(entry,block,raw))return null;context.block=raw;await save();}
 const at={blockHash:block.hash,requireCanonical:true};let walletCode=context.codeReads.find(c=>c.address===batch.wallet)?.result;
 if(walletCode===undefined){check();walletCode=await rpc<string>('eth_getCode',[batch.wallet,at]);if(typeof walletCode!=='string'||!/^0x(?:[\da-f]{2})*$/i.test(walletCode)||walletCode.length>2+128*1024*2)return null;context.codeReads.push({address:batch.wallet,blockHash:block.hash,result:walletCode});await save();}
 if(walletCode.toLowerCase()!=='0xef0100'+FRESH_SELF_CALL_DELEGATE.slice(2))return null;
 if(!context.codeReads.some(c=>c.address===FRESH_SELF_CALL_DELEGATE)){check();const code=await rpc<string>('eth_getCode',[FRESH_SELF_CALL_DELEGATE,at]);if(typeof code!=='string'||!/^0x(?:[\da-f]{2})*$/i.test(code)||code.length>2+128*1024*2)return null;context.codeReads.push({address:FRESH_SELF_CALL_DELEGATE,blockHash:block.hash,result:code});ready();await save();}
 return ready()?context:null;
}
/** Current raw envelope wins every race. A proof from a different original
 * transaction or canonical block cannot replace it or erase diagnostics. */
export function mergeFreshSelfCallContext(selected:FreshCapturedReceipt,latest:FreshCapturedReceipt,context:FreshSelfCallExecutionContext){
 if(identity(selected)!==identity(latest))throw Error('self_call_original_context_changed');
 if(!context.block)throw Error('self_call_execution_context_invalid');const block={number:Number(freshInteger(latest.receipt.blockNumber)),hash:latest.receipt.blockHash,timestamp:new Date(Number(freshInteger(context.block.timestamp))*1000).toISOString()};
 if(!validateFreshSelfCallCapture(latest,block,context))throw Error('self_call_execution_context_invalid');
 const prior=(latest as Entry).selfCallContext;if(prior&&!validateFreshSelfCallCapture(latest,block,prior))throw Error('self_call_saved_context_invalid');
 const combined:FreshSelfCallExecutionContext=prior?structuredClone(prior):structuredClone(context);
 if(prior){if(JSON.stringify(prior.block)!==JSON.stringify(context.block))throw Error('self_call_execution_context_conflict');for(const code of context.codeReads){const old=combined.codeReads.find(c=>c.address===code.address);if(old&&old.result.toLowerCase()!==code.result.toLowerCase())throw Error('self_call_execution_context_conflict');if(!old)combined.codeReads.push(code);}}
 combined.status='complete';if(!validateFreshSelfCallContext(latest,block,combined))combined.status='partial';if(!validateFreshSelfCallCapture(latest,block,combined))throw Error('self_call_execution_context_invalid');
 if(prior&&JSON.stringify(prior)===JSON.stringify(combined))return null;
 return encodeFreshEvidence({...latest,selfCallContext:combined}as Entry);
}
export async function persistFreshSelfCallContext(database:Pool,selected:FreshCapturedReceipt,context:FreshSelfCallExecutionContext,walletRevision:string){
 const client=await database.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621941)');
 const number=Number(freshInteger(selected.receipt.blockNumber)),hash=selected.receipt.blockHash,wallet=selected.transaction.from;
 const canonical=(await client.query('SELECT block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1 FOR SHARE',[number])).rows[0];if(canonical?.block_hash!==hash){await client.query('ROLLBACK');return false;}
 if(!context.block||Number(freshInteger(context.block.timestamp))*1000!==new Date(canonical.occurred_at).getTime())throw Error('self_call_canonical_time_changed');
 const active=(await client.query('SELECT active,revision,monitoring_from_block,monitoring_to_block FROM fresh.wallets WHERE address=$1 FOR SHARE',[wallet])).rows[0];if(!active?.active||String(active.revision)!==walletRevision||Number(active.monitoring_from_block)>number||active.monitoring_to_block!==null&&Number(active.monitoring_to_block)<number)throw Error('self_call_monitoring_changed');
 const row=(await client.query('SELECT payload,wallet_addresses FROM fresh.recent_evidence WHERE tx_hash=$1 AND block_hash=$2 AND expires_at>clock_timestamp() FOR UPDATE',[selected.transaction.hash,hash])).rows[0];if(!row){await client.query('ROLLBACK');return false;}
 const latest=decodeFreshEvidence(row.payload);if([...row.wallet_addresses].sort().join(',')!==[...latest.wallets].sort().join(','))throw Error('self_call_wallet_context_changed');
 const payload=mergeFreshSelfCallContext(selected,latest,context);if(payload){const changed=await client.query('UPDATE fresh.recent_evidence SET payload=$3 WHERE tx_hash=$1 AND block_hash=$2 AND payload=$4',[selected.transaction.hash,hash,payload,row.payload]);if(changed.rowCount!==1)throw Error('self_call_receipt_compare_failed');}
 await client.query('COMMIT');return Boolean(payload);
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
