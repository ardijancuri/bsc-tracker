import type {TokenCardMetric} from '../../../shared/extension';

/** Serialized by chrome.scripting into the isolated world. Read rendered cards only.
 * Selectors verified from Chrome's rendered BSC Trenches export on 2026-11-02.
 * No fetches, page globals, account state or DOM changes. */
export function readRenderedGmgnTrenches() {
  const url = new URL(location.href);
  const empty = {url:url.href,status:'unsupported' as const,cards:[] as {address:string;name:string;symbol:string;tokenUrl:string;socialUrls:string[];logoUrl:string|null;marketCap:TokenCardMetric|null;volume:TokenCardMetric|null}[],observedAt:Date.now()};
  if(!['https://gmgn.ai','https://www.gmgn.ai'].includes(url.origin)
    ||!['/','/trenches','/trenches/'].includes(url.pathname)||url.searchParams.get('chain')!=='bsc')return empty;
  const root=document.querySelector('#MainDomId');
  if(!root?.querySelector('[data-testid^="trenches"]'))return empty;
  const elements=root.querySelectorAll<HTMLElement>('[data-testid="trench-token-card"]');
  if(elements.length>2000)return empty;
  const cards:typeof empty.cards=[];
  for(const element of elements){
    if(!element.closest('[data-testid^="trenches"]')||!element.getClientRects().length
      ||element.closest('[hidden],[aria-hidden="true"]')||getComputedStyle(element).visibility==='hidden'
      ||getComputedStyle(element).display==='none'||element.getAttribute('data-trenches-token-chain')!=='bsc')continue;
    const address=element.getAttribute('data-trenches-token-address')?.toLowerCase();
    if(!address||!/^0x[0-9a-f]{40}$/.test(address))continue;
    let token:URL;
    try{token=new URL(element.getAttribute('href')??'',url.href);}catch{continue;}
    if(!['https://gmgn.ai','https://www.gmgn.ai'].includes(token.origin)||token.username||token.password
      ||!new RegExp(`^/bsc/token/${address}/?$`,'i').test(token.pathname))continue;
    const title=element.querySelector('[class~="group/token-translation"]');
    const symbol=title?.querySelector(':scope > span')?.textContent?.trim().slice(0,40)??'';
    const name=title?.querySelector(':scope > div')?.textContent?.trim().slice(0,120)??'';
    const socialUrls=[...element.querySelectorAll<HTMLAnchorElement>('a[href]')].slice(0,100)
      .map(anchor=>anchor.getAttribute('href')??'').filter(href=>href.length<=2048);
    const image=element.querySelector<HTMLImageElement>('img[alt="logo" i]');let logoUrl:string|null=null;
    const sources=[image?.getAttribute('src'),image?.getAttribute('data-src')];if(!sources.some(Boolean))sources.push(image?.currentSrc);
    for(const raw of sources)try{if(raw&&raw.length<=2048){const destination=new URL(raw,url.href);if(destination.protocol==='https:'&&!destination.username&&!destination.password){logoUrl=destination.href;break;}}}catch{}
    // This function is injected by value, so it cannot call imported DOM helpers.
    const readMetric = (label: 'MC' | 'V'): TokenCardMetric | null => {
      const prefix = new RegExp(`^${label}\\s*(?=\\$)`);
      const selector = `[data-icon="${label}"], [data-sentry-component="MetricLayer"] span`;
      for (const node of element.querySelectorAll<HTMLElement>(selector)) {
        if (!node.getClientRects().length || node.closest('[hidden]')) continue;
        const style = getComputedStyle(node);
        if (style.visibility !== 'visible') continue;
        const text = node.innerText?.trim() ?? node.textContent?.trim() ?? '';
        if (node.getAttribute('data-icon') !== label && !prefix.test(text)) continue;
        const value = text.replace(prefix, '');
        if (value.length <= 24 && /^\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[KMBT]?$/i.test(value)) return {value, color: style.color};
      }
      return null;
    };
    cards.push({address,name,symbol,tokenUrl:token.href,socialUrls,logoUrl,marketCap:readMetric('MC'),volume:readMetric('V')});
  }
  return {url:url.href,status:'ready' as const,cards,observedAt:Date.now()};
}
