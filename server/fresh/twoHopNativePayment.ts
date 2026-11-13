import{WBNB}from'../launchpad.js';import{v3MarketAbi}from'../nodeMarketProtocols.js';
import{freshHistoricalV3Pool}from'./historicalV3Quote.js';import{freshPoolQuotePair}from'./currentPoolQuote.js';
import type{FreshTransaction,FreshLog}from'./capture.js';
const router='0x1de460f363af910f51726def188f9004276bf4bc',quote='0x4902c5ebc598265ed2212b559b042de8a5eeec3f',hook='0xd838ae611c245b97e07278ed0da551636bb7abdc',zero='0x'+'0'.repeat(40);
const greenMorning='0x13920fe6467e9e3c852b8d365a036c995f0f7777',greenMorningHook='0x61358c246d04c1980585cb95b5a383989471a7c4';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',fee='0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92',deposit='0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',settled='0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a';
const word=(v:bigint|string)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0'),words=(s:string,n:number)=>new RegExp('^0x(?:[a-f0-9]{64}){'+n+'}$').test(s)?s.slice(2).match(/.{64}/g)!:null;
const matches=(l:FreshLog,a:string,s:string,actors:string[])=>l.address===a&&l.topics.length===actors.length+1&&l.topics[0]===s&&actors.every((v,i)=>l.topics[i+1]==='0x'+word(v));
/** Closed native-funded V3 -> V2 route under the existing router settlement
 * policy. Signed input, 1% expense, wrapping, both authenticated pool identities,
 * all intermediate units and exact wallet delivery must reconcile. No price or
 * precision for BNCB is needed; no change/refund is discarded. A retained full
 * trace still overrides any contradiction in the normal decoder. */
export function freshTwoHopNativeBuyCost(tx:FreshTransaction,wallet:string,token:string,raw:bigint,logs:FreshLog[]):bigint|null{try{
 if(!/^0x[a-f0-9]{40}$/.test(token)||[wallet,router,quote,WBNB,hook,zero].includes(token)||tx.from!==wallet||tx.to!==router||tx.chainId!=='0x38'||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||raw<=0n||typeof tx.input!=='string'||!/^0x4d819a2a(?:[a-f0-9]{64}){30}$/.test(tx.input))return null;
 const i=tx.input.slice(10).match(/.{64}/g)!,gross=BigInt(tx.value),v3=freshHistoricalV3Pool(quote,WBNB,2500),v2=freshPoolQuotePair(quote,token);
 const expected:Record<number,bigint|string>={0:160n,1:0n,2:gross,5:2n,6:64n,7:416n,8:1n,9:WBNB,10:quote,11:v3,12:2500n,13:50n,14:0n,15:320n,16:0n,17:0n,18:0n,19:0n,20:quote,21:token,22:v2,23:2500n,24:50n,25:0n,26:320n,27:0n,28:0n,29:0n};
 if(gross<=0n||Object.entries(expected).some(([n,v])=>i[Number(n)]!==word(v))||BigInt('0x'+i[3])<=0n||BigInt('0x'+i[3])>raw||BigInt('0x'+i[4])<=0n)return null;
 let previous=-1n;for(const l of logs){if(l.removed||l.transactionHash!==tx.hash||l.blockHash!==tx.blockHash||BigInt(l.blockNumber)!==BigInt(tx.blockNumber)||BigInt(l.transactionIndex)!==BigInt(tx.transactionIndex)||BigInt(l.logIndex)<=previous)return null;previous=BigInt(l.logIndex);}
 const [charge,wrap,middle,aux,pay,...tail]=logs;
 const isGreenMorning=token===greenMorning,tokenHook=isGreenMorning?greenMorningHook:hook;
 // This GM route may emit a zero WBNB deposit during its callback, and a
 // launchpad hook event before its two balance events. Neither moves funds.
 if(isGreenMorning&&tail[0]&&matches(tail[0],WBNB,deposit,[router])&&tail[0].data==='0x'+word(0n))tail.shift();
 if(isGreenMorning&&tail.length===9&&matches(tail[2],tokenHook,'0x9133664e0c1d4082b28d273cba8cbf8736b36d7908b2e7dd51cc2fed219bdfed',[token,wallet])&&words(tail[2].data,1))tail.splice(2,1);
 if(tail.length!==8)return null;
 const [swap3,delivery,h1,h2,dispatch,sync,swap2,done]=tail;
 if(!matches(charge,router,fee,[zero,wallet])||!matches(wrap,WBNB,deposit,[router])||!matches(middle,quote,transfer,[v3,v2])||!matches(aux,quote,'0x0226a2f5c1ae0e071aeec3d4ebafcefdc5c549be11f40ed27e76e802acccf374',[v3,v2])||!matches(pay,WBNB,transfer,[router,v3])||!matches(delivery,token,transfer,[v2,wallet])||!matches(sync,v2,'0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',[])||!matches(swap2,v2,'0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',[router,wallet])||!matches(done,router,settled,[wallet,wallet,zero]))return null;
 const f=words(charge.data,2),w=words(wrap.data,1),m=words(middle.data,1),p=words(pay.data,1),d=words(delivery.data,1),s=words(sync.data,2),v=words(swap2.data,4),end=words(done.data,28);
 if(!f||!w||!m||!p||!d||!s||!v||!end)return null;const expense=BigInt('0x'+f[0]),wrapped=BigInt('0x'+w[0]),intermediate=BigInt('0x'+m[0]);
 const poolAmounts=token<quote?[0n,intermediate,raw,0n]:[intermediate,0n,0n,raw];
 if(expense!==gross/100n||expense<=0n||expense+wrapped!==gross||wrapped<=0n||intermediate<=0n||BigInt('0x'+f[1])<=0n||BigInt('0x'+f[1])>BigInt('0x'+i[4])||p[0]!==w[0]||d[0]!==word(raw)||aux.data!=='0x'+m[0]+m[0]||s.some(x=>BigInt('0x'+x)<=0n)||v.join('')!==poolAmounts.map(word).join('')||end[0]!==word(gross)||end[1]!==word(raw)||end[2]!==word(96n)||end.slice(3).join('')!==i.slice(5).join(''))return null;
 const hookBalance=words(h2.data,2);
 if(!matches(h1,tokenHook,'0x958648f1075e43b4e661b739150bd66c627e356790e068b3d6ca6b179bd4faa4',[token,wallet])||!words(h1.data,1)||!matches(h2,tokenHook,'0x2a9333f5f64b9c9d299faa0d6699b5db8d59d08388fea8ae78ca2303836a10f8',[token,wallet])||!hookBalance||(!isGreenMorning&&hookBalance[0]!==word(raw))||!matches(dispatch,token,'0xc4f02cd43bed595a7c3ee13e0ee1ec639470a7a0f374837ee7b910779d55f5ba',[])||dispatch.data!=='0x'+[v2,wallet,raw].map(word).join(''))return null;
 if(swap3.address!==v3)return null;const parsed=v3MarketAbi.parseLog(swap3);if(!parsed||parsed.name!=='Swap')return null;
 const encoded=v3MarketAbi.encodeEventLog(parsed.fragment,parsed.args);if(encoded.data!==swap3.data||JSON.stringify(encoded.topics)!==JSON.stringify(swap3.topics)||String(parsed.args.sender).toLowerCase()!==router||String(parsed.args.recipient).toLowerCase()!==v2||BigInt(parsed.args.amount0)!==-intermediate||BigInt(parsed.args.amount1)!==wrapped||BigInt(parsed.args.sqrtPriceX96)<=0n||BigInt(parsed.args.liquidity)<=0n)return null;
 return gross;
 }catch{return null;}}
