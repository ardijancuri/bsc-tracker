import type {FreshTransaction,FreshLog} from './capture.js';

// The same authenticated Flap/GMGN Swap receipt used by nativeSellProceeds.
// A native exact-input purchase must match the signed transaction value, the
// receipt's sender/recipient and the wallet's actual token increase. Neither
// arbitrary tx.value nor an inner pool's gross input is purchase-cost proof.
const routers=new Set(['0x1de460f363af910f51726def188f9004276bf4bc','0x3508dca95a64c9378cb07ef6f40553a50905372a','0xef312c613199ac91ee23743565e6a4e4e65fe2c0']);
const topic='0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a';
const zero='0x'+'0'.repeat(40);
const addr=(word:string|undefined)=>word&&/^0{24}[\da-f]{40}$/i.test(word)?'0x'+word.slice(-40).toLowerCase():null;
export function freshNativeBuyCost(tx:FreshTransaction,wallet:string,token:string,receivedRaw:bigint,logs:FreshLog[]):bigint|null {
  const router=tx.to?.toLowerCase();wallet=wallet.toLowerCase();token=token.toLowerCase();
  if(!router||!routers.has(router)||tx.from.toLowerCase()!==wallet||receivedRaw<=0n||!/^0x[\da-f]+$/i.test(tx.value)||BigInt(tx.value)<=0n)return null;
  const swaps=logs.filter(l=>l.address.toLowerCase()===router&&l.topics[0]?.toLowerCase()===topic);
  if(swaps.length!==1)return null;
  const l=swaps[0];
  if(l.removed||l.topics.length!==4||addr(l.topics[1]?.slice(2))!==wallet||addr(l.topics[2]?.slice(2))!==wallet
    ||!/^0x(?:[\da-f]{64})+$/i.test(l.data)||l.data.length>2+64*1024)return null;
  const words=l.data.slice(2).match(/.{64}/g)!;
  if(words.length<16||BigInt('0x'+words[2])!==96n||BigInt('0x'+words[3])!==1n||BigInt('0x'+words[4])!==32n
    ||addr(words[6])!==zero||addr(words[7])!==token)return null;
  const spent=BigInt('0x'+words[0]),received=BigInt('0x'+words[1]);
  if(spent!==BigInt(tx.value)||received!==receivedRaw)return null;
  return spent;
}
