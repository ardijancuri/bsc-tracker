import type {MarketMomentumToken} from '../../shared/trendingTokens.js';
import {freshArtworkUrl} from './artwork.js';

const addressPattern=/^0x[0-9a-f]{40}$/;
const retryAfterMs=60_000,metadataTtl=120_000,taxTtl=5*60_000,maxEntries=128;
type ArtworkDetails={image?:string;marketCapUsd?:string};
type TaxDetails={buyTaxBps?:number;sellTaxBps?:number};
type Cached<T>={value:T;expires:number};
type MarketRecord={type?:unknown;id?:unknown;attributes?:{address?:unknown;market_cap_usd?:unknown;image_url?:unknown}};

export async function readTrendingProviderJson(url:string,fetcher:typeof fetch){
  const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(2300)});
  if(!response.ok||!response.body){await response.body?.cancel();return null;}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let bytes=0;
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>256*1024){await reader.cancel();return null;}
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{reader.releaseLock();}
}

function parseTax(value:unknown){
  if(typeof value!=='string'||!/^\d(?:\.\d{1,36})?$/.test(value))return undefined;
  const ratio=Number(value);
  return ratio<=1?Math.round(ratio*10_000):undefined;
}

export async function readGoPlusTrendingTax(address:string,fetcher=fetch):Promise<TaxDetails>{
  if(!addressPattern.test(address))return {};
  const body=await readTrendingProviderJson('https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses='+address,fetcher).catch(()=>null);
  const record=body?.code===1?body.result?.[address]:null;
  return {buyTaxBps:parseTax(record?.buy_tax),sellTaxBps:parseTax(record?.sell_tax)};
}

/** Display-only metadata for ranked public contracts. The node owns the
 * ranking, counts and volume. External results never enter the ledger. */
export function createNodeMomentumDetails(fetcher=fetch,now=Date.now){
  const metadata=new Map<string,Cached<ArtworkDetails>>();
  const tax=new Map<string,Cached<TaxDetails>>();
  let busy:Promise<void>|undefined,lastBatch=-Infinity;

  function remember<T>(cache:Map<string,Cached<T>>,address:string,value:T,ttl:number){
    cache.delete(address);
    cache.set(address,{value,expires:now()+ttl});
    if(cache.size>maxEntries)cache.delete(cache.keys().next().value!);
  }

  async function loadMetadata(addresses:string[]){
    if(!addresses.length)return;
    const body=await readTrendingProviderJson('https://api.geckoterminal.com/api/v2/networks/bsc/tokens/multi/'+addresses.join(','),fetcher).catch(()=>null);
    const records:MarketRecord[]=Array.isArray(body?.data)?body.data:[];
    for(const address of addresses){
      const row=records.find(record=>record?.type==='token'&&record.id==='bsc_'+address&&
        typeof record.attributes?.address==='string'&&record.attributes.address.toLowerCase()===address);
      const details:ArtworkDetails={};
      const cap=row?.attributes?.market_cap_usd;
      if(typeof cap==='string'&&cap.length<=48&&/^\d+(?:\.\d+)?$/.test(cap)&&Number(cap)>0)details.marketCapUsd=cap;
      const raw=row?.attributes?.image_url;
      if(typeof raw==='string'&&freshArtworkUrl(raw)){
        const url=new URL(raw);
        if(url.origin==='https://coin-images.coingecko.com'&&url.pathname.startsWith('/coins/images/'))details.image=url.href;
      }
      remember(metadata,address,details,Object.keys(details).length?metadataTtl:retryAfterMs);
    }
  }

  async function loadTax(address:string){
    const {buyTaxBps,sellTaxBps}=await readGoPlusTrendingTax(address,fetcher);
    remember(tax,address,{buyTaxBps,sellTaxBps},buyTaxBps!==undefined||sellTaxBps!==undefined?taxTtl:retryAfterMs);
  }

  function image(address:string){
    const entry=metadata.get(address);
    return entry&&entry.expires>now()?entry.value.image:undefined;
  }

  return {
    image,
    async enrich(items:MarketMomentumToken[]){
      const addresses=[...new Set(items.map(item=>item.address).filter(address=>addressPattern.test(address)))].slice(0,4);
      if(addresses.length&&!busy&&now()-lastBatch>=5_000){
        const artwork=addresses.filter(address=>(metadata.get(address)?.expires??0)<=now());
        const taxes=items.filter(item=>addresses.includes(item.address)&&item.buyTaxBps===undefined&&item.sellTaxBps===undefined
          &&(tax.get(item.address)?.expires??0)<=now());
        if(artwork.length||taxes.length){
          lastBatch=now();
          busy=Promise.all([loadMetadata(artwork),...taxes.map(item=>loadTax(item.address))]).then(()=>{}).finally(()=>{busy=undefined;});
        }
      }
      await busy;
      return items.map(item=>{
        const info=metadata.get(item.address),risk=tax.get(item.address);
        const fallbackTax=item.buyTaxBps===undefined&&item.sellTaxBps===undefined&&risk&&risk.expires>now()?risk.value:undefined;
        return {...item,marketCapUsd:item.marketCapUsd??(info&&info.expires>now()?info.value.marketCapUsd??null:null),
          logoUrl:image(item.address)?'/api/token-image/'+item.address+'?fallback=momentum':null,
          ...(fallbackTax&&(fallbackTax.buyTaxBps!==undefined||fallbackTax.sellTaxBps!==undefined)?{...fallbackTax,taxSource:'goplus' as const}:{})};
      });
    },
  };
}
