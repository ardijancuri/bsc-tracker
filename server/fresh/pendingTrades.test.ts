import{describe,it,expect}from'vitest';
import{freshPendingGangTrade}from'./pendingTrades.js';
import{pendingGangFixture,pendingAddress,pendingHash}from'./fixtures/pendingGangTradeFixture.js';
import{normalizeFreshReceipt}from'./decode.js';
import{GANG_TOKEN_ADDRESS,FRESH_GANG_HISTORY_FROM_BLOCK,FRESH_GANG_CREATION_HASH,FRESH_GANG_CREATION_TIME}from'./tracking.js';
import{WBNB}from'../launchpad.js';
describe('compact unnormalized GANG swap observations',()=>{
 it('retains exact raw units and identity without guessing native buy settlement, decimals or USD',()=>{
  const f=pendingGangFixture(),before=structuredClone(f),p=freshPendingGangTrade(f.entry,f.block,f.admission)!;
  expect(p).toMatchObject({kind:'buy',rawQuantity:'1000000000000000000',quoteAmount:null,quoteAddress:null,quoteSymbol:null,executionIndex:0});
  expect(p).not.toHaveProperty('quantity');expect(p).not.toHaveProperty('amountUsd');expect(p).not.toHaveProperty('realizedProfitUsd');expect(f).toEqual(before);
 });
 it('retains the exact ordinary-EOA gas payment and shared execution fee identity without assigning USD',()=>{
  const f=pendingGangFixture();f.entry.transaction.gasPrice='0x3b9aca00';f.entry.receipt.effectiveGasPrice='0x3b9aca00';
  const p=freshPendingGangTrade(f.entry,f.block,f.admission)!;expect(p.nativeFeeWei).toBe('21000000000000');
  expect(p.feeKey).toBe(`${f.block.hash}:${f.entry.transaction.hash}:${f.wallet}:transaction:0:fee`);expect(p).not.toHaveProperty('feeUsd');
 });
 it('retains only a receipt-validated native sell payout and keeps historical requeues silent',()=>{
  const f=pendingGangFixture('sell');f.entry.historicalWallets=[f.wallet];const p=freshPendingGangTrade(f.entry,f.block,f.admission)!;
  expect(p).toMatchObject({kind:'sell',quoteAddress:WBNB,quoteSymbol:'BNB',quoteAmount:'0.000000000000001',observedLive:false});
  f.entry.receipt.logs.pop();expect(freshPendingGangTrade(f.entry,f.block,f.admission)?.quoteAmount).toBeNull();
 });
 it('binds immutable swap evidence while rechecking mutable wallet and silent collection context',()=>{
  const f=pendingGangFixture(),before=freshPendingGangTrade(f.entry,f.block,f.admission)!;
  f.entry.wallets.push(pendingAddress(8));f.entry.historicalWallets=[f.wallet];const merged=freshPendingGangTrade(f.entry,f.block,f.admission)!;
  expect(merged.id).toBe(before.id);expect(merged.rawQuantity).toBe(before.rawQuantity);expect(merged.evidenceHash).toBe(before.evidenceHash);expect(merged.observedLive).toBe(false);
  f.entry.wallets=[pendingAddress(8)];expect(freshPendingGangTrade(f.entry,f.block,f.admission)).toBeNull();
 });
 it('uses only the validated GANG history timestamp floor for a historical ordinary swap',()=>{
  const f=pendingGangFixture();if(f.admission.kind!=='preexisting')throw Error('fixture_admission');
  f.block={number:129505802,hash:pendingHash(129505802),timestamp:'2026-10-24T12:00:00.000Z'};
  f.entry.transaction.blockNumber='0x'+f.block.number.toString(16);f.entry.transaction.blockHash=f.block.hash;
  f.entry.receipt.blockNumber=f.entry.transaction.blockNumber;f.entry.receipt.blockHash=f.block.hash;
  for(const log of f.entry.receipt.logs){log.blockNumber=f.entry.transaction.blockNumber;log.blockHash=f.block.hash;}
  const permission={...f.admission.permission,startBlock:129627586,startHash:pendingHash(129627586),startTime:'2026-10-25T02:42:03.000Z',fromBlock:129627587};
  f.admission={...f.admission,permission,fromBlock:FRESH_GANG_HISTORY_FROM_BLOCK,history:{version:1,kind:'explicit_token_history',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,
   startBlock:permission.startBlock,startHash:permission.startHash,startTime:permission.startTime,historyFromBlock:FRESH_GANG_HISTORY_FROM_BLOCK,historyFromHash:FRESH_GANG_CREATION_HASH,
   historyFromTime:FRESH_GANG_CREATION_TIME,sourceDatasetSha256:'a'.repeat(64),approvedAt:'2026-10-25T13:00:00.000Z',policy:'gmgn_gang_only_history_v1'}};
  f.entry.historicalWallets=[f.wallet];expect(freshPendingGangTrade(f.entry,f.block,f.admission)?.observedLive).toBe(false);
  f.entry.wallets=[];expect(freshPendingGangTrade(f.entry,f.block,f.admission)).toBeNull();
 });
 it('does not weaken the original time floor without validated history admission',()=>{
  const f=pendingGangFixture();f.block.timestamp='2026-10-24T12:00:00.000Z';expect(freshPendingGangTrade(f.entry,f.block,f.admission)).toBeNull();
 });
 const invalidCases:[string,(f:any)=>void][]=[
  ['no permission',(f:any)=>f.admission=null],['other permission',(f:any)=>f.admission.permission.tokenAddress=pendingAddress(8)],
  ['wrong chain',(f:any)=>f.entry.transaction.chainId='0x1'],['failed receipt',(f:any)=>f.entry.receipt.status='0x0'],
  ['unwatched wallet',(f:any)=>f.entry.wallets=[]],['self call',(f:any)=>f.entry.transaction.to=f.wallet],
  ['smart operation',(f:any)=>f.entry.transaction.type='0x4'],['authorization',(f:any)=>f.entry.transaction.authorizationList=[]],
  ['launch repair',(f:any)=>f.entry.launchRepair={version:1}],['foreign pool',(f:any)=>f.entry.receipt.logs[1].address=pendingAddress(9)],
  ['other token',(f:any)=>f.entry.receipt.logs[0].address=pendingAddress(8)],['different received raw',(f:any)=>f.entry.receipt.logs[0].data='0x'+'0'.repeat(63)+'1'],
  ['different recipient',(f:any)=>f.entry.receipt.logs[0].topics[2]='0x'+pendingAddress(5).slice(2).padStart(64,'0')],
  ['removed log',(f:any)=>f.entry.receipt.logs[0].removed=true],['bad swap',(f:any)=>f.entry.receipt.logs[1].data='0x'],
  ['second swap',(f:any)=>f.entry.receipt.logs.push({...f.entry.receipt.logs[1],logIndex:'0x2'})],
  ['second transfer',(f:any)=>f.entry.receipt.logs.push({...f.entry.receipt.logs[0],logIndex:'0x2'})],
  ['no swap',(f:any)=>f.entry.receipt.logs.pop()],['wrong tx log',(f:any)=>f.entry.receipt.logs[0].transactionHash=pendingHash(9)],
  ['wrong block',(f:any)=>f.block.hash=pendingHash(9)],['before permission',(f:any)=>f.admission.fromBlock=1003],
  ['bad timestamp',(f:any)=>f.block.timestamp='bad']
 ];
 it.each(invalidCases)('rejects %s',(_name,mutate)=>{const f=pendingGangFixture();mutate(f);expect(freshPendingGangTrade(f.entry,f.block,f.admission)).toBeNull();});
 it('uses the exact normal decoder ID and disappears as soon as normal quantity is available',async()=>{
  const f=pendingGangFixture('sell'),block={number:f.entry.transaction.blockNumber,hash:f.block.hash,timestamp:'0x'+Math.floor(Date.parse(f.block.timestamp)/1000).toString(16)};
  const services={knownLaunch:async(token:string)=>token===GANG_TOKEN_ADDRESS,eligible:async(token:any)=>token.address===GANG_TOKEN_ADDRESS,priceUsd:async(token:string)=>token===WBNB?'600':null,tradeAdmission:async()=>f.admission};
  const missing=await normalizeFreshReceipt(f.entry,block,{...services,metadata:async()=>null});expect(missing.events).toEqual([]);expect(missing.pendingTrades).toHaveLength(1);expect(missing.reasons).toContain('token_decimals_unavailable');
  const known=await normalizeFreshReceipt(f.entry,block,{...services,metadata:async(address:string)=>({address,decimals:18,name:'Fixture',symbol:'GANG',supplyRaw:null,block:f.block})});
  expect(known.events).toHaveLength(1);expect(known.events[0].id).toBe(missing.pendingTrades![0].id);expect(known.events[0].executionKey).toBe(missing.pendingTrades![0].executionKey);expect(known.pendingTrades).toBeUndefined();
 });
});
