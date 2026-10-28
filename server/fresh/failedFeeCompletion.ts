import{createHash}from'node:crypto';
import{Interface}from'ethers';
import{freshAddress,freshHash,freshInteger,validateFreshReceipt,type FreshCapturedReceipt}from'./capture.js';
import type{FreshDecodedReceipt}from'./decode.js';

const attempts=new Interface(['function transfer(address to,uint256 value)','function approve(address spender,uint256 value)','function transferFrom(address from,address to,uint256 value)']);
/** A failed ordinary transaction commits no EVM asset movement. Its paid gas
 * remains a fact; standard calldata names only a fee-attribution candidate. */
export function freshFailedStandardTokenAttempt(entry:FreshCapturedReceipt){
 try{
  const{transaction:tx,receipt:r}=entry,contract=freshAddress(tx.to),wallet=freshAddress(tx.from);
  if(r.status!=='0x0'||r.logs.length||r.contractAddress||!contract||!wallet||!entry.wallets.includes(wallet)
   ||!freshHash(tx.blockHash)||freshHash(tx.blockHash)!==freshHash(r.blockHash)||freshInteger(tx.blockNumber)!==freshInteger(r.blockNumber)
   ||!freshHash(tx.hash)||freshHash(tx.hash)!==freshHash(r.transactionHash)||freshInteger(tx.transactionIndex)!==freshInteger(r.transactionIndex)
   ||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||freshInteger(tx.chainId)!==56n||typeof tx.input!=='string')return null;
  validateFreshReceipt(r,tx,{number:r.blockNumber,hash:r.blockHash,parentHash:r.blockHash,timestamp:'0x0',transactions:[tx]});
  const parsed=attempts.parseTransaction({data:tx.input});
  if(!parsed||attempts.encodeFunctionData(parsed.fragment,parsed.args).toLowerCase()!==tx.input.toLowerCase())return null;
  return{contract,wallet,selector:tx.input.slice(0,10).toLowerCase(),nativeFeeWei:freshInteger(r.gasUsed)*freshInteger(r.effectiveGasPrice??tx.gasPrice)};
 }catch{return null;}
}
/** Only movement coverage completes. Pending token identity and the original
 * warning survive in the receipt/discovery job. Unattributed gas stays in its
 * existing separate bucket; it is never called an eligible trading expense. */
export function freshFailedFeeOnlyCompletion(decoded:FreshDecodedReceipt,entry:FreshCapturedReceipt){
 try{
  const a=freshFailedStandardTokenAttempt(entry);
  if(!a||entry.launchRepair||decoded.executions!==1||decoded.events.length!==1||decoded.tokens.length||decoded.syntheticTransferBatch
   ||decoded.pendingTrades?.length||decoded.directTransferIntents?.length||decoded.reasons.length!==1||decoded.reasons[0]!=='token_discovery_pending'
   ||decoded.discoveryPendingTokens?.length!==1||decoded.discoveryPendingTokens[0]!==a.contract)return false;
  const e=decoded.events[0],prefix=`${entry.receipt.blockHash}:${entry.transaction.hash}:${a.wallet}:transaction:0`,key=prefix+':native_fee:fee:aggregate',fee=e.feeAttribution;
  return e.id===createHash('sha256').update(key).digest('hex')&&e.executionKey===key&&e.feeKey===prefix+':fee'
   &&e.kind==='fee'&&e.tokenAddress===null&&e.walletAddress===a.wallet&&e.canonical!==false&&e.quantity==='0'&&e.amountUsd==='0'
   &&typeof e.feeUsd==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(e.feeUsd)&&e.counterparty===null&&e.transferKey===null&&e.logIndex===null
   &&e.blockHash===entry.receipt.blockHash&&e.transactionHash===entry.transaction.hash&&e.blockNumber===freshInteger(entry.receipt.blockNumber).toString()
   &&e.transactionIndex===Number(freshInteger(entry.transaction.transactionIndex))&&e.executionIndex===0
   &&fee?.status==='unattributed'&&fee.contract===a.contract&&fee.selector===a.selector&&fee.tokenAddress===undefined
   &&fee.nativeFeeWei===a.nativeFeeWei.toString()&&fee.expensePolicy===undefined;
 }catch{return false;}
}
