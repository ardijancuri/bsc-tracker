import{Interface}from'ethers';
import{INFINITY_CL,TRUSTED_QUOTE_FEEDS,authenticatedPoolKey,infinityMarketAbi}from'../nodeMarketProtocols.js';
import{transferTopic}from'../swap.js';
import{freshInteger,validateFreshReceipt,type FreshCapturedReceipt}from'./capture.js';
import{validFreshCompleteCallTrace}from'./passiveIncoming.js';
import{validateFreshTrace,type FreshCallTrace}from'./trace.js';
import{FRESH_UNISWAP_V4_BSC_MANAGER,freshStockwavePoolId,stockwavePoolManagerInterface}from'./stockwaveMarket.js';

const zero='0x'+'0'.repeat(40),vault='0x238a358808379702088667322f80ac48bad5e6c4';
const uni=new Interface(['function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData) returns(int256)']);
const pcs=new Interface(['function swap((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData) returns(int256)']);
const address=(t:string|undefined)=>t&&/^0x0{24}[a-f0-9]{40}$/.test(t)?'0x'+t.slice(-40):null;
const signed128=(n:bigint)=>n>=1n<<127n?n-(1n<<128n):n;

/** A split native acquisition can contain several official v4 swaps and a
 * Pancake Infinity leg. Each exact pool key, returned delta, official event and
 * wallet delivery must agree. This proves trade linkage only; ordinary exact
 * native settlement and dated feed valuation still calculate its cost. */
export function freshV4SplitNativeBuy(entry:FreshCapturedReceipt,wallet:string,token:string,raw:bigint):boolean{
 try{
  const tx=entry.transaction,r=entry.receipt;
  if(raw<=0n||tx.from!==wallet||!entry.wallets.includes(wallet)||!tx.to||tx.to===wallet||!['0x0','0x1','0x2'].includes(String(tx.type))
   ||tx.authorizationList!==undefined||freshInteger(tx.value)<=0n||r.status!=='0x1'||!entry.trace||r.logs.length>512)return false;
  validateFreshReceipt(r,tx,{number:r.blockNumber,hash:r.blockHash,parentHash:r.blockHash,timestamp:'0x0',transactions:[tx]});
  const trace=validateFreshTrace(entry.trace);if(!validFreshCompleteCallTrace(entry,trace))return false;
  const calls:FreshCallTrace[]=[];
  const walk=(c:FreshCallTrace,root=false)=>{if(c.error)return;if(!root&&(c.from===wallet||c.to===wallet))throw Error('wallet_reentry');
   if(c.type==='CALL'&&(c.to===FRESH_UNISWAP_V4_BSC_MANAGER||c.to===INFINITY_CL))calls.push(c);c.calls?.forEach(x=>walk(x));};walk(trace,true);
  const delivered=new Map<string,bigint>(),expected=new Map<string,bigint>();let quantity=0n,uniSwaps=0,totalSwaps=0;
  for(const l of r.logs){if(l.topics[0]!==transferTopic)continue;
   if(l.removed||l.topics.length!==3||!/^0x[a-f0-9]{64}$/.test(l.data))return false;
   const from=address(l.topics[1]),to=address(l.topics[2]);if(from!==wallet&&to!==wallet)continue;
   if(l.address!==token||to!==wallet||from!==FRESH_UNISWAP_V4_BSC_MANAGER&&from!==vault||BigInt(l.data)<=0n)return false;
   quantity+=BigInt(l.data);delivered.set(from,(delivered.get(from)??0n)+BigInt(l.data));
  }
  if(quantity!==raw)return false;
  for(const manager of[FRESH_UNISWAP_V4_BSC_MANAGER,INFINITY_CL]){
   const isUni=manager===FRESH_UNISWAP_V4_BSC_MANAGER,abi=isUni?uni:pcs,eventAbi=isUni?stockwavePoolManagerInterface:infinityMarketAbi;
   const swaps=r.logs.filter(l=>l.address===manager&&l.topics[0]===eventAbi.getEvent('Swap')!.topicHash);
   const executions=calls.filter(c=>c.to===manager&&c.input?.slice(0,10)===abi.getFunction('swap')!.selector);
   if(swaps.length!==executions.length||swaps.length>8)return false;
   for(let i=0;i<swaps.length;i++){
    const l=swaps[i],c=executions[i],p=eventAbi.parseLog(l),a=abi.parseTransaction({data:c.input!});if(l.removed||!p||!a||abi.encodeFunctionData(a.fragment,a.args)!==c.input||c.value&&freshInteger(c.value)!==0n)return false;
    const encoded=eventAbi.encodeEventLog(p.fragment,p.args);if(encoded.data!==l.data||JSON.stringify(encoded.topics)!==JSON.stringify(l.topics))return false;
    const k=a.args.key,params=a.args.params,c0=String(k.currency0).toLowerCase(),c1=String(k.currency1).toLowerCase(),hooks=String(k.hooks).toLowerCase();
    if(c0>=c1||hooks!==zero||c0!==token&&c1!==token||a.args.hookData!=='0x'||BigInt(params.amountSpecified)>=0n)return false;
    const quote=c0===token?c1:c0;if(quote!==zero&&!TRUSTED_QUOTE_FEEDS[quote])return false;
    if(isUni){if(Number(k.tickSpacing)<=0||Number(k.tickSpacing)>32767||freshStockwavePoolId({currency0:c0,currency1:c1,fee:Number(k.fee),tickSpacing:Number(k.tickSpacing),hooks})!==String(p.args.id).toLowerCase())return false;}
    else if(!authenticatedPoolKey(p.args.id,manager,[c0,c1,hooks,String(k.poolManager).toLowerCase(),k.fee,k.parameters]))return false;
    if(!c.output||!/^0x[a-f0-9]{64}$/.test(c.output)||String(p.args.sender).toLowerCase()!==c.from)return false;
    const packed=BigInt(c.output),a0=signed128(packed>>128n),a1=signed128(packed&((1n<<128n)-1n));
    if(a0!==BigInt(p.args.amount0)||a1!==BigInt(p.args.amount1)||a0===0n||a1===0n||(a0<0n)===(a1<0n)
     ||BigInt(p.args.sqrtPriceX96)<=0n||BigInt(p.args.liquidity)<=0n||BigInt(p.args.fee)>1_000_000n)return false;
    const amount=c0===token?a0:a1;if(amount<=0n||Boolean(params.zeroForOne)!==(c1===token))return false;
    const settlement=isUni?manager:vault;expected.set(settlement,(expected.get(settlement)??0n)+amount);totalSwaps++;if(isUni)uniSwaps++;
   }
  }
  return uniSwaps>0&&totalSwaps<=8&&expected.size===delivered.size&&[...expected].every(([asset,n])=>delivered.get(asset)===n);
 }catch{return false;}
}
