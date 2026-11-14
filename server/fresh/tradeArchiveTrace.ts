import type {Pool} from 'pg';
import type {Rpc} from '../rpc.js';
import {freshInteger,validateFreshReceipt,type FreshBlock,type FreshCapturedReceipt} from './capture.js';
import {certifyFreshCompleteCallTrace,validFreshCompleteCallTrace} from './passiveIncoming.js';
import {validateFreshTrace} from './trace.js';
import {validatePnlRawCallTree} from './pnlEvidenceRepair.js';
import type {FreshPriceBlock} from './pricing.js';
import {freshPublicTradeScopeSql} from './publicTokens.js';

type HeaderWithHashes=Pick<FreshBlock,'number'|'hash'|'parentHash'|'timestamp'>&{transactions:string[]};

/** Only a published KOL trade with a missing amount may use archive capacity.
 * The owned node binds the returned call tree to a confirmed local receipt. */
export function createFreshTradeArchiveTrace(database:Pick<Pool,'query'>,node:Rpc,archive:Rpc){
  let nextAttemptAt=0;
  return async(entry:FreshCapturedReceipt,block:FreshPriceBlock)=>{
    const {transaction,receipt}=entry;
    if(Date.now()<nextAttemptAt||entry.trace&&validFreshCompleteCallTrace(entry,entry.trace)
      ||receipt.status!=='0x1'||!entry.wallets.includes(transaction.from))return null;
    const eligible=await database.query(`SELECT 1 FROM fresh.financial_events f
      WHERE f.transaction_hash=$1 AND f.block_number=$2 AND f.block_hash=$3 AND f.wallet_address=$4
        AND f.amount_usd IS NULL AND ${freshPublicTradeScopeSql('f')} LIMIT 1`,
      [transaction.hash,block.number,block.hash,transaction.from]);
    if(!eligible.rowCount)return null;
    if(Date.now()<nextAttemptAt)return null;
    nextAttemptAt=Date.now()+15_000;
    const params=[transaction.blockNumber,false];
    const header=await node<HeaderWithHashes>('eth_getBlockByNumber',params);
    if(!header||header.hash!==block.hash||header.number!==transaction.blockNumber||
      header.transactions[Number(freshInteger(transaction.transactionIndex))]!==transaction.hash)return null;
    validateFreshReceipt(receipt,transaction,{...header,transactions:[transaction]});
    const request={method:'debug_traceTransaction',params:[transaction.hash,
      {tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]};
    const trace=validatePnlRawCallTree(await archive(request.method,request.params),entry);
    if(entry.trace&&JSON.stringify(validateFreshTrace(entry.trace))!==JSON.stringify(trace))return null;
    if((await node<FreshBlock>('eth_getBlockByNumber',params))?.hash!==block.hash)return null;
    return{trace,completeTraceProof:certifyFreshCompleteCallTrace(entry,trace,request,'operator_archive')};
  };
}
