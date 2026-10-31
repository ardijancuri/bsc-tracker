import {AbiCoder,Interface,getCreate2Address,keccak256,solidityPackedKeccak256} from 'ethers';
import {PCS_V2_FACTORY} from '../launchpad.js';
import {INFINITY_CL,TRUSTED_QUOTE_FEEDS,authenticatedPoolKey,infinityMarketAbi,poolMarketAbi,v3MarketAbi} from '../nodeMarketProtocols.js';
import {transferTopic} from '../swap.js';
import {freshInteger,validateFreshReceipt,type FreshCapturedReceipt} from './capture.js';
import {FRESH_PCS_V2_PAIR_INITCODE_HASH} from './flapQuoteRecovery.js';
import {FRESH_PCS_V3_DEPLOYER,FRESH_PCS_V3_INITCODE_HASH} from './currentV3Quote.js';
import {validFreshCompleteCallTrace} from './passiveIncoming.js';
import {FRESH_UNISWAP_V4_BSC_MANAGER,freshStockwavePoolId,stockwavePoolManagerInterface} from './stockwaveMarket.js';
import {validateFreshTrace,type FreshCallTrace} from './trace.js';

const zero='0x'+'0'.repeat(40),vault='0x238a358808379702088667322f80ac48bad5e6c4',coder=AbiCoder.defaultAbiCoder();
const tokenAbi=new Interface(['function transfer(address to,uint256 amount)returns(bool)','function transferFrom(address from,address to,uint256 amount)returns(bool)']);
const v2=new Interface(['function swap(uint256 amount0Out,uint256 amount1Out,address to,bytes data)']);
const v3=new Interface(['function swap(address recipient,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,bytes data)returns(int256,int256)']);
const uni=new Interface(['function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData)returns(int256)']);
const pcs=new Interface(['function swap((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,bytes hookData)returns(int256)']);
const topicAddress=(v:string|undefined)=>v&&/^0x0{24}[a-f0-9]{40}$/.test(v)?'0x'+v.slice(-40):null;
const signed128=(n:bigint)=>n>=1n<<127n?n-(1n<<128n):n;
const add=(m:Map<string,bigint>,k:string,n:bigint)=>m.set(k,(m.get(k)??0n)+n);
type Pool={kind:'v2'|'v3';assets:string[]};
function legacyPools(token:string){
 const pools=new Map<string,Pool>();
 for(const quote of Object.keys(TRUSTED_QUOTE_FEEDS)){
  if(quote===token)continue;const assets=[token,quote].sort();
  pools.set(getCreate2Address(PCS_V2_FACTORY,solidityPackedKeccak256(['address','address'],assets),FRESH_PCS_V2_PAIR_INITCODE_HASH).toLowerCase(),{kind:'v2',assets});
  for(const fee of[100,500,2500,10000])pools.set(getCreate2Address(FRESH_PCS_V3_DEPLOYER,keccak256(coder.encode(['address','address','uint24'],[...assets,fee])),FRESH_PCS_V3_INITCODE_HASH).toLowerCase(),{kind:'v3',assets});
 }
 return pools;
}

/** Link a single ordinary wallet execution across authenticated V2/V3/V4 legs.
 * All wallet target transfers must match successful token calls and the exact
 * pool deltas. Complete traces, immutable PCS pool addresses and v4 pool-key
 * hashes supply identity; router names/topics alone supply none. This returns
 * no monetary value: existing native/quote settlement, dated feeds, fees and
 * final balance reconciliation remain mandatory. Unsupported hooks, wallet
 * reentry and multiple acquired assets remain explicit repairs. */
export function freshMixedV4Settlement(entry:FreshCapturedReceipt,wallet:string,token:string,raw:bigint):boolean{
 try{
  const tx=entry.transaction,r=entry.receipt,buy=raw>0n;
  if(raw===0n||tx.from!==wallet||!entry.wallets.includes(wallet)||!tx.to||tx.to===wallet||!['0x0','0x1','0x2'].includes(String(tx.type))
   ||tx.authorizationList!==undefined||r.status!=='0x1'||!entry.trace||r.logs.length>512)return false;
  if(!r.logs.some(l=>l.address===FRESH_UNISWAP_V4_BSC_MANAGER&&l.topics[0]===stockwavePoolManagerInterface.getEvent('Swap')!.topicHash))return false;
  validateFreshReceipt(r,tx,{number:r.blockNumber,hash:r.blockHash,parentHash:r.blockHash,timestamp:'0x0',transactions:[tx]});
  const trace=validateFreshTrace(entry.trace);if(!validFreshCompleteCallTrace(entry,trace))return false;
  const calls:FreshCallTrace[]=[];
  const walk=(c:FreshCallTrace,root=false)=>{
   if(!['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT'].includes(c.type))throw Error('unsupported_call_type');
   if(c.error)return;
   if(!root&&(c.from===wallet||c.to===wallet&&!(c.type==='CALL'&&c.input==='0x'&&c.value&&freshInteger(c.value)>0n&&!c.calls?.length)))throw Error('wallet_reentry');
   if(c.type==='CALL')calls.push(c);c.calls?.forEach(x=>walk(x));
  };walk(trace,true);
  const delivered=new Map<string,bigint>(),expected=new Map<string,bigint>(),quoteFlows=new Map<string,bigint>(),neededCalls=new Map<string,number>(),actualCalls=new Map<string,number>();
  let quantity=0n;
  const transferKey=(from:string,to:string,amount:bigint)=>JSON.stringify([from,to,amount.toString()]);
  for(const l of r.logs){
   if(l.topics[0]!==transferTopic)continue;
   const from=topicAddress(l.topics[1]),to=topicAddress(l.topics[2]);if(from!==wallet&&to!==wallet)continue;
   if(l.removed||l.topics.length!==3||!from||!to||!/^0x[a-f0-9]{64}$/.test(l.data))return false;
   const n=BigInt(l.data),signed=(to===wallet?n:0n)-(from===wallet?n:0n);
   if(l.address!==token){if(!TRUSTED_QUOTE_FEEDS[l.address])return false;add(quoteFlows,l.address,signed);continue;}
   if(n<=0n||buy&&(to!==wallet||from===wallet)||!buy&&(from!==wallet||to===wallet))return false;
   quantity+=signed;add(delivered,buy?from:to,signed);
   const k=transferKey(from,to,n);neededCalls.set(k,(neededCalls.get(k)??0)+1);
  }
  if(quantity!==raw||[...quoteFlows.values()].filter(n=>n!==0n).length>1||[...quoteFlows.values()].some(n=>buy?n>0n:n<0n))return false;
  for(const c of calls){
   if(c.to!==token||!c.input||c.value&&freshInteger(c.value)!==0n)continue;
   let p;try{p=tokenAbi.parseTransaction({data:c.input});}catch{continue;}
   if(!p||tokenAbi.encodeFunctionData(p.fragment,p.args)!==c.input)continue;
   const from=p.name==='transfer'?c.from:String(p.args.from).toLowerCase(),to=String(p.args.to).toLowerCase(),n=BigInt(p.args.amount);
   if(from!==wallet&&to!==wallet)continue;
   if(c.output!=='0x'&&c.output!==coder.encode(['bool'],[true]))return false;
   const k=transferKey(from,to,n);actualCalls.set(k,(actualCalls.get(k)??0)+1);
  }
  if([...neededCalls].some(([k,n])=>actualCalls.get(k)!==n))return false;
  const pools=legacyPools(token);let totalSwaps=0,uniSwaps=0;
  for(const manager of[FRESH_UNISWAP_V4_BSC_MANAGER,INFINITY_CL]){
   const isUni=manager===FRESH_UNISWAP_V4_BSC_MANAGER,abi=isUni?uni:pcs,eventAbi=isUni?stockwavePoolManagerInterface:infinityMarketAbi;
   const logs=r.logs.filter(l=>l.address===manager&&l.topics[0]===eventAbi.getEvent('Swap')!.topicHash);
   const executions=calls.filter(c=>c.to===manager&&c.input?.slice(0,10)===abi.getFunction('swap')!.selector);
   if(logs.length!==executions.length||logs.length>16)return false;
   for(let i=0;i<logs.length;i++){
    const l=logs[i],c=executions[i],p=eventAbi.parseLog(l),a=abi.parseTransaction({data:c.input!});
    if(!p||!a||abi.encodeFunctionData(a.fragment,a.args)!==c.input||c.value&&freshInteger(c.value)!==0n)return false;
    const encoded=eventAbi.encodeEventLog(p.fragment,p.args);if(encoded.data!==l.data||JSON.stringify(encoded.topics)!==JSON.stringify(l.topics))return false;
    const k=a.args.key,params=a.args.params,c0=String(k.currency0).toLowerCase(),c1=String(k.currency1).toLowerCase(),hooks=String(k.hooks).toLowerCase();
    if(c0>=c1||hooks!==zero||c0!==token&&c1!==token||a.args.hookData!=='0x'||BigInt(params.amountSpecified)===0n)return false;
    const quote=c0===token?c1:c0;if(quote!==zero&&!TRUSTED_QUOTE_FEEDS[quote])return false;
    if(isUni){if(freshStockwavePoolId({currency0:c0,currency1:c1,fee:Number(k.fee),tickSpacing:Number(k.tickSpacing),hooks})!==String(p.args.id).toLowerCase())return false;}
    else if(!authenticatedPoolKey(p.args.id,manager,[c0,c1,hooks,String(k.poolManager).toLowerCase(),k.fee,k.parameters]))return false;
    if(!c.output||!/^0x[a-f0-9]{64}$/.test(c.output)||String(p.args.sender).toLowerCase()!==c.from)return false;
    const packed=BigInt(c.output),a0=signed128(packed>>128n),a1=signed128(packed&((1n<<128n)-1n));
    if(a0!==BigInt(p.args.amount0)||a1!==BigInt(p.args.amount1)||a0===0n||a1===0n||(a0<0n)===(a1<0n)
     ||BigInt(p.args.sqrtPriceX96)<=0n||BigInt(p.args.liquidity)<=0n||BigInt(p.args.fee)>1_000_000n)return false;
    const amount=c0===token?a0:a1;if((amount>0n)!==buy||Boolean(params.zeroForOne)!==(buy?c1===token:c0===token))return false;
    add(expected,isUni?manager:vault,amount);totalSwaps++;if(isUni)uniSwaps++;
   }
  }
  for(const [pool,amount]of delivered){
   if(pool===FRESH_UNISWAP_V4_BSC_MANAGER||pool===vault)continue;
   const identity=pools.get(pool);if(!identity)return false;
   const abi=identity.kind==='v2'?v2:v3,eventAbi=identity.kind==='v2'?poolMarketAbi:v3MarketAbi;
   const logs=r.logs.filter(l=>l.address===pool&&l.topics[0]===eventAbi.getEvent('Swap')!.topicHash),executions=calls.filter(c=>c.to===pool&&c.input?.slice(0,10)===abi.getFunction('swap')!.selector);
   if(!logs.length||logs.length!==executions.length||logs.length>16)return false;
   for(let i=0;i<logs.length;i++){
    const l=logs[i],c=executions[i],p=eventAbi.parseLog(l),a=abi.parseTransaction({data:c.input!});
    if(!p||!a||abi.encodeFunctionData(a.fragment,a.args)!==c.input||c.value&&freshInteger(c.value)!==0n||String(p.args.sender).toLowerCase()!==c.from)return false;
    const encoded=eventAbi.encodeEventLog(p.fragment,p.args);if(encoded.data!==l.data||JSON.stringify(encoded.topics)!==JSON.stringify(l.topics))return false;
    const target0=identity.assets[0]===token;let delta:bigint;
    if(identity.kind==='v2'){
     const a0in=BigInt(p.args.amount0In),a1in=BigInt(p.args.amount1In),a0out=BigInt(p.args.amount0Out),a1out=BigInt(p.args.amount1Out);
     if(BigInt(a.args.amount0Out)!==a0out||BigInt(a.args.amount1Out)!==a1out||String(a.args.to).toLowerCase()!==String(p.args.to).toLowerCase()
      ||!((a0in>0n&&a1out>0n&&a1in===0n&&a0out===0n)||(a1in>0n&&a0out>0n&&a0in===0n&&a1out===0n)))return false;
     delta=target0?a0out-a0in:a1out-a1in;if(buy&&String(a.args.to).toLowerCase()!==wallet)return false;
    }else{
     if(!c.output||!/^0x[a-f0-9]{128}$/.test(c.output))return false;
     const [a0,a1]=coder.decode(['int256','int256'],c.output).map(BigInt);
     if(a0!==BigInt(p.args.amount0)||a1!==BigInt(p.args.amount1)||a0===0n||a1===0n||(a0<0n)===(a1<0n)||BigInt(a.args.amountSpecified)===0n
      ||Boolean(a.args.zeroForOne)!==(buy?!target0:target0)||String(a.args.recipient).toLowerCase()!==String(p.args.recipient).toLowerCase()
      ||buy&&String(a.args.recipient).toLowerCase()!==wallet||BigInt(p.args.sqrtPriceX96)<=0n||BigInt(p.args.liquidity)<=0n)return false;
     delta=-(target0?a0:a1);
    }
    if((delta>0n)!==buy)return false;add(expected,pool,delta);totalSwaps++;
   }
   if(expected.get(pool)!==amount)return false;
  }
  return uniSwaps>0&&totalSwaps<=16&&expected.size===delivered.size&&[...expected].every(([p,n])=>delivered.get(p)===n);
 }catch{return false;}
}
