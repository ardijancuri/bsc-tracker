import{describe,it,expect}from'vitest';
import{Interface}from'ethers';
import{decodeFreshEvidence}from'./capture.js';
import{FreshRational}from'./accounting.js';
import{recoverFreshGangTradeMarketMark}from'./gangTradeMarketMark.js';
import{GANG_TOKEN_ADDRESS,freshTokenAdmissionDigest,type FreshTokenAdmission,type FreshExistingTokenPermission}from'./tracking.js';
import metadata from'../fixtures/gang-metadata-witness.json'with{type:'json'};
import trades from'../fixtures/gang-trade-mark-witness.json'with{type:'json'};
import{freshPendingGangTrade,FRESH_GANG_PAIR}from'./pendingTrades.js';
import{transferTopic}from'../swap.js';
const syncAbi=new Interface(['event Sync(uint112 reserve0,uint112 reserve1)']);
const swapAbi=new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
function input(index=0){
 const selected=trades.entries[index],headers=new Map([metadata.source.block,metadata.runtime.block,metadata.after.block,...trades.entries.map(e=>e.block)].map(b=>[b.number,b]));
 const p:FreshExistingTokenPermission={version:1 as const,kind:'explicit_existing' as const,chainId:56 as const,tokenAddress:GANG_TOKEN_ADDRESS,active:true as const,startBlock:trades.boundary.block_number,
  startHash:trades.boundary.block_hash,startTime:trades.boundary.value.startTime,fromBlock:trades.boundary.block_number+1,approvedAt:'2026-10-25T12:00:00.000Z',reason:'user_approved_gang_only' as const};
 return{entry:decodeFreshEvidence(Buffer.from(selected.payloadBase64,'base64')),metadata:{chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,target:structuredClone(selected.block),
  source:{block:structuredClone(metadata.source.block),payload:Buffer.from(metadata.source.payloadBase64,'base64')},runtime:structuredClone(metadata.runtime),after:structuredClone(metadata.after),
  canonicalHeader:async(n:number)=>headers.get(n)??null},admission:{kind:'preexisting',permission:p,fromBlock:p.fromBlock,admissionDigest:freshTokenAdmissionDigest(p),launchStatus:'preexisting'}as FreshTokenAdmission};
}
function routedInput(side:'buy'|'sell',router='0xb300000b72deaeb607a12d5f54773d1c19c7028d'){
 const x=input(side==='buy'?7:0),wallet=x.entry.transaction.from;
 x.entry.transaction.to=router;x.entry.transaction.input=(router.startsWith('0x01a21')?'0xa21413d8':'0x810c705b')+'00';
 const transfer=x.entry.receipt.logs.find(l=>l.address===GANG_TOKEN_ADDRESS&&l.topics[0]===transferTopic)!,index=x.entry.receipt.logs.indexOf(transfer);
 const topic=(a:string)=>'0x'+a.slice(2).padStart(64,'0'),points=side==='buy'?[FRESH_GANG_PAIR,router,wallet]:[wallet,router,FRESH_GANG_PAIR];
 x.entry.receipt.logs.splice(index,1,{...transfer,topics:[transferTopic,topic(points[0]),topic(points[1])]},{...transfer,topics:[transferTopic,topic(points[1]),topic(points[2])]});
 x.entry.receipt.logs.forEach((l,i)=>l.logIndex='0x'+i.toString(16));
 if(side==='buy'){const log=x.entry.receipt.logs.find(l=>l.address===FRESH_GANG_PAIR&&l.topics[0]===swapAbi.getEvent('Swap')!.topicHash)!,parsed=swapAbi.parseLog(log)!;
  Object.assign(log,swapAbi.encodeEventLog('Swap',[parsed.args.sender,parsed.args.amount0In,parsed.args.amount1In,parsed.args.amount0Out,parsed.args.amount1Out,router]));}
 return x;
}
describe('historical GANG post-trade market-cap observations',()=>{
 it('values exactly four actual saved dated-feed receipts, keeping six missing feeds explicit',async()=>{
  let ready=0,missing=0;for(let i=0;i<trades.entries.length;i++){const x=input(i),before=JSON.stringify(x.entry),mark=await recoverFreshGangTradeMarketMark(x as any);
   expect(JSON.stringify(x.entry)).toBe(before);if(!mark){missing++;continue;}ready++;
   const e=mark.evidence,expected=new FreshRational(BigInt(e.reserveBnbRaw)*BigInt(e.supplyRaw),BigInt(e.reserveTokenRaw)*10n**18n).mul(FreshRational.parse(e.bnbUsd));
   expect(mark.marketCapUsd).toBe(expected.decimal());expect(mark.kind).toBe('post_trade_pool_sync');expect(mark.source).toBe('node');
   expect(mark.transactionHash).toBe(x.entry.transaction.hash);expect(mark.observedAt).toBe(x.metadata.target.timestamp);
   expect(FreshRational.parse(mark.marketCapUsd).n).toBeGreaterThan(0n);expect(e.metadataProof).toMatchObject({kind:'same_block_raw_metadata'});
  }expect(ready).toBe(4);expect(missing).toBe(6);
 });
 it.each(['missing_sync','duplicate_sync','zero_reserve','wrong_pair','missing_supply','future_feed','orphan']as const)('rejects %s without substituting current token values',async mode=>{
  const i=trades.entries.findIndex(e=>decodeFreshEvidence(Buffer.from(e.payloadBase64,'base64')).stateEvidence?.calls.some(c=>c.data==='0xfeaf968c'));
  const x=input(i),sync=x.entry.receipt.logs.find(l=>l.topics[0]===syncAbi.getEvent('Sync')!.topicHash)!;
  if(mode==='missing_sync')x.entry.receipt.logs=x.entry.receipt.logs.filter(l=>l!==sync);
  if(mode==='duplicate_sync')x.entry.receipt.logs.push({...sync});
  if(mode==='zero_reserve')sync.data=syncAbi.encodeEventLog(syncAbi.getEvent('Sync')!,[0,1]).data;
  if(mode==='wrong_pair')sync.address='0x'+'1'.repeat(40);
  if(mode==='missing_supply'){delete(x.metadata as any).after;x.entry.stateEvidence!.calls=x.entry.stateEvidence!.calls.filter(c=>c.data!=='0x18160ddd');}
  if(mode==='future_feed'){const c=x.entry.stateEvidence!.calls.find(c=>c.data==='0xfeaf968c')!;c.result='0x'+'0'.repeat(c.result.length-2);}
  if(mode==='orphan')x.metadata.canonicalHeader=async()=>null;
  expect(await recoverFreshGangTradeMarketMark(x as any)).toBeNull();
 });
 it.each([['buy','0xb300000b72deaeb607a12d5f54773d1c19c7028d'],['sell','0xb300000b72deaeb607a12d5f54773d1c19c7028d'],['sell','0x01a21c857a3219991fba2b1a2824b1b758966b54']]as const)('marks conserved two-leg%s for%s without admitting a pending swap',async(side,router)=>{
  const x=routedInput(side,router),before=JSON.stringify(x.entry),mark=await recoverFreshGangTradeMarketMark(x as any);
  expect(mark?.side).toBe(side);expect(mark?.walletAddress).toBe(x.entry.transaction.from);expect(mark?.marketCapUsd).toBeTruthy();
  expect(JSON.stringify(x.entry)).toBe(before);expect(freshPendingGangTrade(x.entry,x.metadata.target,x.admission)).toBeNull();
 });
 it.each(['extra_transfer','different_recipient','different_amount','extra_swap','padded_swap_data','malformed_shape','wrong_selector','wrong_router','wrong_buy_recipient','aa']as const)('rejects routed mark %s',async mode=>{
  const x=routedInput(mode==='wrong_buy_recipient'?'buy':'sell'),logs=x.entry.receipt.logs,legs=logs.filter(l=>l.address===GANG_TOKEN_ADDRESS&&l.topics[0]===transferTopic);
  if(mode==='extra_transfer')logs.push({...legs[1],logIndex:'0xffff'});
  if(mode==='different_recipient')legs[1].topics[2]='0x'+'1'.repeat(64);
  if(mode==='different_amount')legs[1].data='0x'+(BigInt(legs[1].data)+1n).toString(16).padStart(64,'0');
  if(mode==='extra_swap')logs.push({...logs.find(l=>l.address===FRESH_GANG_PAIR&&l.topics[0]===swapAbi.getEvent('Swap')!.topicHash)!,logIndex:'0xffff'});
  if(mode==='padded_swap_data')logs.find(l=>l.address===FRESH_GANG_PAIR&&l.topics[0]===swapAbi.getEvent('Swap')!.topicHash)!.data+='0'.repeat(64);
  if(mode==='malformed_shape')x.entry.transaction.input+='z';if(mode==='wrong_selector')x.entry.transaction.input='0xdeadbeef';
  if(mode==='wrong_router')x.entry.transaction.to='0x'+'1'.repeat(40);if(mode==='aa')x.entry.transaction.type='0x4';
  if(mode==='wrong_buy_recipient'){const log=logs.find(l=>l.address===FRESH_GANG_PAIR&&l.topics[0]===swapAbi.getEvent('Swap')!.topicHash)!,parsed=swapAbi.parseLog(log)!;Object.assign(log,swapAbi.encodeEventLog('Swap',[parsed.args.sender,...parsed.args.slice(1,5),x.entry.transaction.from]));}
  expect(await recoverFreshGangTradeMarketMark(x as any)).toBeNull();
 });
});
