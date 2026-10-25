import {describe,it,expect} from 'vitest';
import {beforeExecutionTopic,userOperationTopic} from '../smartAccountTrades.js';
import {WBNB} from '../launchpad.js';
import {transferTopic} from '../swap.js';
import {freshQuotePayment} from './quotePayment.js';
import type {FreshCapturedReceipt,FreshLog} from './capture.js';
const wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40),router='0x'+'3'.repeat(40),pool='0x'+'4'.repeat(40),other='0x'+'5'.repeat(40);
const quote='0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',hash='0x'+'a'.repeat(64),txHash='0x'+'b'.repeat(64);
const block={number:10000,hash,timestamp:'2026-10-23T20:00:00.000Z'},word=(value:string|bigint)=>typeof value==='string'?value.slice(2).padStart(64,'0'):value.toString(16).padStart(64,'0');
const transfer=(asset:string,from:string,to:string,raw:bigint,index:number):FreshLog=>({address:asset,topics:[transferTopic,'0x'+word(from),'0x'+word(to)],data:'0x'+word(raw),
  blockNumber:'0x2710',blockHash:hash,transactionHash:txHash,transactionIndex:'0x1',logIndex:'0x'+index.toString(16)});
function fixture():FreshCapturedReceipt{return {transaction:{hash:txHash,from:wallet,to:router,value:'0x0',type:'0x2',gasPrice:'0x3b9aca00',blockNumber:'0x2710',blockHash:hash,transactionIndex:'0x1'},
  receipt:{transactionHash:txHash,blockNumber:'0x2710',blockHash:hash,transactionIndex:'0x1',status:'0x1',gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs:[
    transfer(quote,wallet,pool,99n,1),transfer(quote,wallet,router,1n,2),transfer(token,pool,wallet,500n,3)]},wallets:[wallet],observedAt:block.timestamp};}
const proof=(e:FreshCapturedReceipt)=>freshQuotePayment(e,block,token,wallet,500n);
describe('settled trusted ERC20 raw quote payment',()=>{
  it('keeps all paid raw quote units and gas distinct without assuming quote precision',()=>{
    expect(proof(fixture())).toEqual({version:1,kind:'wallet_erc20_quote_settlement',side:'buy',transactionHash:txHash,blockNumber:10000,blockHash:hash,
      transactionIndex:1,walletAddress:wallet,tokenAddress:token,quoteAddress:quote,tokenRaw:'500',quoteRaw:'100',outgoingQuoteRaw:'100',incomingQuoteRaw:'0',gasFeeWei:'100000000000000',
      quoteTransferLogIndices:[1,2],tokenTransferLogIndices:[3]});
  });
  it('includes actual same-route refunds and separately paid quote fees exactly once',()=>{
    const e=fixture();e.receipt.logs.push(transfer(quote,router,wallet,7n,4));
    expect(proof(e)).toMatchObject({quoteRaw:'93',outgoingQuoteRaw:'100',incomingQuoteRaw:'7',quoteTransferLogIndices:[1,2,4]});
    e.receipt.logs[3]=transfer(quote,pool,wallet,7n,4);expect(proof(e)?.quoteRaw).toBe('93');
  });
  it('rejects native value, self calls, authorization lists, AA and unsupported transaction kinds',()=>{
    for(const patch of[{value:'0x1'},{to:wallet},{authorizationList:[]},{type:'0x4'},{type:'0x3'},{to:'0x4337084d9e255ff0702461cf8895ce9e3b5ff108'}]){
      const e=fixture();Object.assign(e.transaction,patch);expect(proof(e)).toBeNull();
    }
    for(const topic of[beforeExecutionTopic,userOperationTopic]){const e=fixture();e.receipt.logs.push({...transfer(token,pool,wallet,1n,4),topics:[topic],data:'0x'});expect(proof(e)).toBeNull();}
  });
  it('rejects another wallet, receipt block, transaction position or delivery quantity',()=>{
    const e=fixture();e.transaction.from=other;expect(proof(e)).toBeNull();
    const f=fixture();f.receipt.transactionIndex='0x2';expect(proof(f)).toBeNull();
    expect(freshQuotePayment(fixture(),{...block,hash:'0x'+'c'.repeat(64)},token,wallet,500n)).toBeNull();
    expect(freshQuotePayment(fixture(),block,token,wallet,501n)).toBeNull();
  });
  it('rejects malformed, removed, duplicated, reordered and foreign log identities',()=>{
    for(const patch of[{removed:true},{logIndex:'0x1'},{blockHash:'0x'+'f'.repeat(64)},{transactionHash:'0x'+'f'.repeat(64)},{transactionIndex:'0x2'},{data:'0x1'},{topics:[transferTopic]}]){
      const e=fixture();Object.assign(e.receipt.logs[2],patch);expect(proof(e)).toBeNull();
    }
  });
  it('requires one opposing trusted quote and no other wallet asset operations',()=>{
    for(const asset of[other,WBNB]){const e=fixture();e.receipt.logs[0].address=asset;e.receipt.logs[1].address=asset;expect(proof(e)).toBeNull();}
    const e=fixture();e.receipt.logs.push(transfer(other,pool,wallet,1n,4));expect(proof(e)).toBeNull();
    const f=fixture();f.receipt.logs.push(transfer(token,wallet,other,1n,4));expect(proof(f)).toBeNull();
  });
  it('does not treat unrelated quote receipts, minting or nonpositive net payment as refunds',()=>{
    for(const from of[other,'0x'+'0'.repeat(40)]){const e=fixture();e.receipt.logs.push(transfer(quote,from,wallet,7n,4));expect(proof(e)).toBeNull();}
    const e=fixture();e.receipt.logs.push(transfer(quote,router,wallet,100n,4));expect(proof(e)).toBeNull();
    const f=fixture();f.receipt.logs.push(transfer(quote,wallet,wallet,1n,4));expect(proof(f)).toBeNull();
  });
  it('rejects saved native flows or mismatching traces instead of hiding fee or payout conflicts',()=>{
    const e=fixture();e.trace={type:'CALL',from:wallet,to:router,value:'0x0',calls:[]};expect(proof(e)?.quoteRaw).toBe('100');
    e.trace.calls=[{type:'CALL',from:wallet,to:other,value:'0x1'}];expect(proof(e)).toBeNull();
    e.trace.calls=[{type:'CALL',from:router,to:wallet,value:'0x1'}];expect(proof(e)).toBeNull();
    e.trace={type:'CALL',from:other,to:router,value:'0x0'};expect(proof(e)).toBeNull();
  });
  it('requires successful receipt and explicit wallet-paid gas',()=>{
    for(const patch of[{status:'0x0'},{gasUsed:'0x0'},{effectiveGasPrice:'0x0'}]){const e=fixture();Object.assign(e.receipt,patch);expect(proof(e)).toBeNull();}
  });
  it('values actual net quote sale proceeds and includes wallet-paid quote fees once',()=>{
    const e=fixture();e.receipt.logs=[transfer(token,wallet,router,500n,1),transfer(quote,router,wallet,100n,2)];
    const sell=()=>freshQuotePayment(e,block,token,wallet,-500n);
    expect(sell()).toMatchObject({side:'sell',tokenRaw:'500',quoteRaw:'100',outgoingQuoteRaw:'0',incomingQuoteRaw:'100'});
    e.receipt.logs.push(transfer(quote,wallet,router,3n,3));expect(sell()?.quoteRaw).toBe('97');
    expect(freshQuotePayment(e,block,token,wallet,500n)).toBeNull();
  });
  it('keeps token transfer taxes in exact sold quantity without counting another target or returned target units',()=>{
    const e=fixture();e.receipt.logs=[transfer(token,wallet,token,5n,1),transfer(token,wallet,pool,495n,2),transfer(quote,router,wallet,100n,3)];
    expect(freshQuotePayment(e,block,token,wallet,-500n)).toMatchObject({side:'sell',tokenRaw:'500',quoteRaw:'100'});
    e.receipt.logs.push(transfer(token,pool,wallet,1n,4));expect(freshQuotePayment(e,block,token,wallet,-499n)).toBeNull();
  });
  it('rejects unrelated sale quote income, unrelated outgoing quote and wrong proceeds direction',()=>{
    const e=fixture();e.receipt.logs=[transfer(token,wallet,router,500n,1),transfer(quote,other,wallet,100n,2)];
    expect(freshQuotePayment(e,block,token,wallet,-500n)).toBeNull();
    e.receipt.logs[1]=transfer(quote,router,wallet,100n,2);e.receipt.logs.push(transfer(quote,wallet,other,3n,3));expect(freshQuotePayment(e,block,token,wallet,-500n)).toBeNull();
    e.receipt.logs[2]=transfer(quote,wallet,router,100n,3);expect(freshQuotePayment(e,block,token,wallet,-500n)).toBeNull();
    expect(freshQuotePayment(fixture(),block,token,wallet,0n)).toBeNull();
  });
});
