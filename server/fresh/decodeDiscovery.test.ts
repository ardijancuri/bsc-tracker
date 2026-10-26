import{describe,expect,it,vi}from'vitest';
import{Interface}from'ethers';
import{normalizeFreshReceipt,finishFreshDecodedReceipt,type FreshDecodeServices}from'./decode.js';
import{FRESH_UNISWAP_V4_BSC_MANAGER as manager,stockwavePoolManagerInterface as v4}from'./stockwaveMarket.js';
import{transferTopic}from'../swap.js';
import{WBNB}from'../launchpad.js';
import type{FreshCapturedReceipt,FreshLog}from'./capture.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';

const address=(c:string)=>`0x${c.repeat(40)}`,hash=(c:string)=>`0x${c.repeat(64)}`;
const wallet=address('1'),router=address('2'),token=address('3'),airdrop=address('4'),quote='0x55d398326f99059ff775485246999027b3197955';
const block={number:'0x65',hash:hash('a'),timestamp:'0x69000000'};
const word=(v:bigint|string)=>(typeof v==='bigint'?v.toString(16):v.slice(2)).padStart(64,'0');
const log=(emitter:string,topics:string[],data:string,index:number):FreshLog=>({address:emitter,topics,data,logIndex:`0x${index.toString(16)}`,transactionHash:hash('b'),transactionIndex:'0x0',blockNumber:block.number,blockHash:block.hash});
const transfer=(asset:string,from:string,to:string,raw:bigint,index=0)=>log(asset,[transferTopic,`0x${word(from)}`,`0x${word(to)}`],`0x${word(raw)}`,index);
function swap(index=1){const e=v4.encodeEventLog('Swap',[hash('c'),router,-99n,1_000n,2n**96n,1_000_000n,0,3000]);return log(manager,e.topics,e.data,index);}
function entry(logs:FreshLog[],value='0x64'):FreshCapturedReceipt{return{wallets:[wallet],observedAt:'2026-10-25T19:00:00Z',transaction:{hash:hash('b'),from:wallet,to:router,value,blockNumber:block.number,blockHash:block.hash,transactionIndex:'0x0',gasPrice:'0x1'},receipt:{transactionHash:hash('b'),transactionIndex:'0x0',blockNumber:block.number,blockHash:block.hash,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs}};}
function services(status:'eligible'|'excluded'|'pending'='pending'):FreshDecodeServices{return{tokenDiscovery:async asset=>asset===token||asset===airdrop?status:'excluded',metadata:async asset=>({address:asset,name:'New token',symbol:'NEW',decimals:9,supplyRaw:'1000000000000000000',block:{number:101,hash:block.hash,timestamp:'2026-10-25T19:00:00Z'}}),eligible:async()=>true,priceUsd:async asset=>asset===WBNB?'600':'1',quotePaymentUsd:async()=> '12'};}

describe('unknown launch classification without silent financial approval',()=>{
  it.each(['buy','sell']as const)('retains a genuine official v4 %s as discovery pending without scaled quantity or P&L',async side=>{
    const incoming=side==='buy',value=entry([transfer(token,incoming?manager:wallet,incoming?wallet:manager,1_000n),swap()],incoming?'0x64':'0x0');
    const metadata=vi.fn(services().metadata),priceUsd=vi.fn(services().priceUsd);
    const result=await normalizeFreshReceipt(value,block,{...services(),metadata,priceUsd});
    expect(result.events).toEqual([]);expect(result.tokens).toEqual([]);expect(result.pendingTrades).toBeUndefined();
    expect(result.reasons).toEqual(['token_discovery_pending']);expect(result.discoveryPendingTokens).toEqual([token]);expect(priceUsd).not.toHaveBeenCalled();
  });
  it('reprocesses an authenticated admission through ordinary swap accounting, preserving nine-decimal units',async()=>{
    const value=entry([transfer(token,manager,wallet,1_000n),swap()]);
    const result=await normalizeFreshReceipt(value,block,{...services('eligible'),knownLaunch:async()=>false});
    expect(result.events).toHaveLength(1);expect(result.events[0]).toMatchObject({tokenAddress:token,kind:'buy',quantity:'0.000001',amountUsd:'12'});
    expect(result.discoveryPendingTokens).toBeUndefined();expect(result.reasons).toEqual([]);
  });
  it('keeps authenticated old/excluded tokens excluded without reading their historical metadata',async()=>{
    const metadata=vi.fn(services().metadata),result=await normalizeFreshReceipt(entry([transfer(token,manager,wallet,1_000n),swap()]),block,{...services('excluded'),metadata});
    expect(result.events).toEqual([]);expect(result.reasons).toEqual([]);expect(result.discoveryPendingTokens).toBeUndefined();expect(metadata).not.toHaveBeenCalled();
  });
  it('preserves legacy fixed-import knownLaunch false as exclusion',async()=>{
    const{tokenDiscovery:_,...legacy}=services();const metadata=vi.fn(legacy.metadata);
    const result=await normalizeFreshReceipt(entry([transfer(token,manager,wallet,1_000n),swap()]),block,{...legacy,knownLaunch:async()=>false,metadata});
    expect(result.events).toEqual([]);expect(result.reasons).toEqual([]);expect(metadata).not.toHaveBeenCalled();
  });
  it('does not schedule an unsolicited incoming airdrop from a third-party transaction',async()=>{
    const value=entry([transfer(token,router,wallet,1_000n),swap()]);value.transaction.from=router;
    const metadata=vi.fn(services().metadata),result=await normalizeFreshReceipt(value,block,{...services(),metadata});
    expect(result.reasons).toEqual([]);expect(result.discoveryPendingTokens).toBeUndefined();expect(metadata).not.toHaveBeenCalled();
  });
  it('does not treat an incoming transfer or arbitrary Swap topic without payment as a trade',async()=>{
    for(const logs of[[transfer(token,router,wallet,1_000n)],[transfer(token,router,wallet,1_000n),{...swap(),address:router}]]){
      const result=await normalizeFreshReceipt(entry(logs,'0x0'),block,services());
      expect(result.events).toEqual([]);expect(result.reasons).toEqual([]);expect(result.discoveryPendingTokens).toBeUndefined();
    }
  });
  it('ignores an unrelated incoming airdrop accompanying a paid acquisition',async()=>{
    const result=await normalizeFreshReceipt(entry([transfer(token,manager,wallet,1_000n),transfer(airdrop,router,wallet,2n,1),swap(2)]),block,services());
    expect(result.discoveryPendingTokens).toEqual([token]);expect(result.reasons).toEqual(['token_discovery_pending']);
  });
  it('retains an unsupported but explicit single-asset paid acquisition as a classification task',async()=>{
    const result=await normalizeFreshReceipt(entry([transfer(token,router,wallet,1_000n)]),block,services());
    expect(result.discoveryPendingTokens).toEqual([token]);expect(result.events).toEqual([]);expect(result.reasons).toEqual(['token_discovery_pending']);
  });
  it('retains an unsupported actual outgoing wallet movement without inventing a sale',async()=>{
    const result=await normalizeFreshReceipt(entry([transfer(token,wallet,router,1_000n)],'0x0'),block,services());
    expect(result.discoveryPendingTokens).toEqual([token]);expect(result.events).toEqual([]);
  });
  it('recognizes known-quote payment without treating the quote itself as a new token',async()=>{
    const result=await normalizeFreshReceipt(entry([transfer(quote,wallet,router,10n),transfer(token,router,wallet,1_000n,1)],'0x0'),block,services());
    expect(result.discoveryPendingTokens).toEqual([token]);expect(result.events).toEqual([]);
  });
  it.each(['LP','USDC','Dividend Tracker'])('keeps auxiliary/quote identity %s outside discovery repair',async symbol=>{
    const normal=services(),result=await normalizeFreshReceipt(entry([transfer(token,manager,wallet,1_000n),swap()]),block,{...normal,metadata:async asset=>({...((await normal.metadata(asset))!),symbol})});
    expect(result.reasons).toEqual([]);expect(result.discoveryPendingTokens).toBeUndefined();
  });
  it('keeps missing metadata explicitly pending rather than defaulting to eighteen decimals',async()=>{
    const result=await normalizeFreshReceipt(entry([transfer(token,manager,wallet,1_000n),swap()]),block,{...services(),metadata:async()=>null});
    expect(result.discoveryPendingTokens).toEqual([token]);expect(result.tokens).toEqual([]);expect(result.events).toEqual([]);expect(result.reasons).toEqual(['token_discovery_pending']);
  });
  it('does not claim a malformed/spoofed v4 payload is a normalized swap',async()=>{
    for(const bad of[{...swap(),data:`${swap().data}${'0'.repeat(64)}`},{...swap(),address:router}]){
      const result=await normalizeFreshReceipt(entry([transfer(token,manager,wallet,1_000n),bad],'0x0'),block,services('eligible'));
      if(bad.address===manager){expect(result.events).toEqual([]);expect(result.reasons).toEqual(['v4_swap_execution_unsupported']);}
      else expect(result.events.map(event=>event.kind)).toEqual(['transfer_in']);
    }
  });
  it('does not approve another manager movement with unrelated raw quantity, direction or multiple swaps',async()=>{
    for(const logs of[[transfer(token,manager,wallet,999n),swap()],[transfer(token,wallet,manager,1_000n),swap()],[transfer(token,manager,wallet,1_000n),swap(),swap(2)]]){
      const value=entry(logs,'0x0'),original=structuredClone(value),result=await normalizeFreshReceipt(value,block,services('eligible'));
      expect(result.events).toEqual([]);expect(result.reasons).toEqual(['v4_swap_execution_unsupported']);expect(value).toEqual(original);
    }
  });
  it('keeps self-transfer zero movement outside discovery repair',async()=>{
    const result=await normalizeFreshReceipt(entry([transfer(token,wallet,wallet,1_000n),swap()]),block,services());
    expect(result.discoveryPendingTokens).toBeUndefined();expect(result.reasons).toEqual([]);
  });
  it('durably retains discovery repair and the original receipt instead of approving an empty DONE result',async()=>{
    const value=entry([transfer(token,manager,wallet,1_000n),swap()]),decoded=await normalizeFreshReceipt(value,block,services());
    const query=vi.fn(async()=>({rows:[],rowCount:1}));
    const result=await finishFreshDecodedReceipt({query}as any,{row:{tx_hash:value.transaction.hash,block_hash:block.hash},entry:value,decoded,
      state:createFreshStateEvidenceRpc(vi.fn()as any,{number:101,hash:block.hash}),now:new Date(value.observedAt)});
    expect(result).toEqual({waiting:true,valuationOnly:false});
    const calls=query.mock.calls as unknown as [string,unknown[]][],update=calls.find(([sql])=>sql.startsWith('UPDATE fresh.recent_evidence'))!;
    expect(update[1].slice(2,5)).toEqual(['repair',3,'token_discovery_pending']);
    // No raw rewrite is needed: the COALESCE update retains the original
    // transaction/receipt bytes, while the durable job stores firstFailure.
    expect(update[1][5]).toBeNull();expect(update[0]).toContain('payload=COALESCE($6,payload)');
    expect(calls.some(([sql])=>sql.startsWith('INSERT INTO fresh.jobs'))).toBe(true);expect(calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);
  });
  it.each(['eligible','excluded','pending']as const)('retains a failed standard token attempt with %s fee attribution',async status=>{
    const value=entry([],'0x0');value.transaction.to=token;value.receipt.status='0x0';
    value.transaction.input=new Interface(['function approve(address spender,uint256 amount)']).encodeFunctionData('approve',[router,100n]);
    const result=await normalizeFreshReceipt(value,block,services(status));
    expect(result.events).toHaveLength(1);expect(result.events[0]).toMatchObject({kind:'fee',quantity:'0',feeUsd:'0.0000000000126',feeAttribution:{status:status==='pending'?'unattributed':status,nativeFeeWei:'21000',contract:token}});
    if(status==='pending'){expect(result.discoveryPendingTokens).toEqual([token]);expect(result.reasons).toEqual(['token_discovery_pending']);expect(result.events[0].tokenAddress).toBeNull();}
    else expect(result.discoveryPendingTokens).toBeUndefined();
  });
  it('keeps a successful unknown standard approval pending without asserting policy exclusion',async()=>{
    const value=entry([],'0x0');value.transaction.to=token;
    value.transaction.input=new Interface(['function approve(address spender,uint256 amount)']).encodeFunctionData('approve',[router,100n]);
    const result=await normalizeFreshReceipt(value,block,services());
    expect(result.reasons).toEqual(['token_discovery_pending']);expect(result.discoveryPendingTokens).toEqual([token]);expect(result.events).toEqual([]);
  });
});
