import type {ExtensionPage} from '../../../shared/extension';
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const samples=[
  {name:'Morning headlines',symbol:'NEWS',platform:'FourMeme',links:['https://x.com/example/status/2117053489755140401','https://t.me/morningnews']},
  {name:'First edition',symbol:'EDITION',platform:'Flap',links:['https://twitter.com/other/status/2117053489755140401?s=20']},
  {name:'The news desk',symbol:'DESK',platform:'PancakeSwap',links:['https://x.com/example/status/2117053489755140401','https://t.me/morningnews/45']},
  {name:'Community coin',symbol:'CIRCLE',platform:'Genius',links:['https://x.com/i/communities/2117053489755140402']},
  {name:'Second circle',symbol:'CIRCLE2',platform:'OpenFour',links:['https://twitter.com/i/communities/2117053489755140402']},
  {name:'Builder season',symbol:'BUILD',platform:'FourMeme',links:['https://x.com/ExampleTeam']},
  {name:'Builder tools',symbol:'TOOLS',platform:'Flap',links:['https://twitter.com/exampleteam?utm_source=token']},
  {name:'Fresh signal',symbol:'SIGNAL',platform:'PancakeSwap',links:[]},
  {name:'Different story',symbol:'STORY',platform:'FourMeme',links:['https://x.com/example/status/2117053489755140499']},
];
const root=document.querySelector<HTMLElement>('[data-kollens-trenches]')!;
const previewFrame=document.querySelector<HTMLIFrameElement>('#panel');
if(previewFrame&&!new URLSearchParams(location.search).has('extension')){
  const toggle=document.createElement('button');toggle.id='toggle-popup';toggle.type='button';toggle.setAttribute('aria-expanded','true');
  const icon=document.createElement('img');icon.src='/assets/icon.png';icon.alt='';toggle.append(icon,'Kollens');
  toggle.onclick=()=>{previewFrame.hidden=!previewFrame.hidden;toggle.setAttribute('aria-expanded',String(!previewFrame.hidden));};document.querySelector('header')!.append(toggle);
}
let next=10,clicks=0;
// Representative value/color pairs from the captured GMGN Trenches cards.
const marketExamples = [
  {cap:'$3.1K',capColor:'240 245 245',volume:'$1.41',volumeColor:'240 245 245'},
  {cap:'$22.2K',capColor:'134 217 159',volume:'$10.7K',volumeColor:'134 217 159'},
  {cap:'$54.6K',capColor:'78 167 250',volume:'$169.3K',volumeColor:'242 195 102'},
  {cap:'$39.1K',capColor:'78 167 250',volume:'$44K',volumeColor:'78 167 250'},
];
function card(n:number,sample=samples[(n-1)%samples.length]){
  const element=document.createElement('article');element.setAttribute('data-token-card','');element.setAttribute('data-token-address',address(n));
  const anchor=document.createElement('a');anchor.setAttribute('data-token-link','');anchor.href=`https://gmgn.ai/bsc/token/${address(n)}?ref=fixture`;
  const title=document.createElement('strong');title.setAttribute('data-token-symbol','');title.textContent=sample.symbol;
  const name=document.createElement('span');name.setAttribute('data-token-name','');name.textContent=sample.name;anchor.append(title,name);
  const badge=document.createElement('div');badge.setAttribute('data-badge-slot','');element.append(badge,anchor);
  const platform=document.createElement('small');platform.textContent=sample.platform;element.append(platform);
  const social=document.createElement('div');social.className='socials';
  for(const link of sample.links){const a=document.createElement('a');a.setAttribute('data-social-link','');a.href=link;a.textContent=link.includes('t.me')?'Telegram':'X';a.target='_blank';a.rel='noopener noreferrer';social.append(a);}
  element.append(social);
  const market = marketExamples[(n-1)%marketExamples.length];
  const line=document.createElement('div');line.className='metrics';
  line.innerHTML=`<span>MCAP <b data-icon="MC" style="color:rgb(${market.capColor})">${market.cap}</b></span><span>VOL <b data-icon="V" style="color:rgb(${market.volumeColor})">${market.volume}</b></span><span>Holders <b>126</b></span>`;
  const button=document.createElement('button');button.className='fake-buy';button.textContent='Test trade button';button.onclick=()=>{clicks++;document.querySelector('[data-trade-clicks]')!.textContent=String(clicks);};element.append(line,button);return element;
}
function append(n:number,sample?:typeof samples[number]){root.children[(n-1)%3].append(card(n,sample));}
for(let n=1;n<=9;n++)append(n);
document.querySelector('#add-match')!.addEventListener('click',()=>append(next++,samples[0]));
document.querySelector('#remove-card')!.addEventListener('click',()=>root.querySelector('[data-token-card]')?.remove());
document.querySelector('#recycle-card')!.addEventListener('click',()=>{const old=root.querySelector('[data-token-card]');if(old)old.replaceWith(card(next++,samples[8]));});
document.querySelector('#sort-cards')!.addEventListener('click',()=>{for(const col of root.children){for(const child of [...col.querySelectorAll('[data-token-card]')].reverse())col.append(child);}});
document.querySelector('#many-cards')!.addEventListener('click',()=>{for(let n=next;n<next+200;n++)append(n);next+=200;});
document.querySelector('#switch-chain')!.addEventListener('click',()=>root.setAttribute('data-chain',root.getAttribute('data-chain')==='bsc'?'sol':'bsc'));
window.addEventListener('kollens:page',event=>{
  const detail=(event as CustomEvent<{page:ExtensionPage}>).detail;
  (window as any).__fixturePage=detail.page;
  const iframe=document.querySelector<HTMLIFrameElement>('#panel');iframe?.contentWindow?.postMessage({kind:'fixture/page',...detail},location.origin);
});
window.addEventListener('message',event=>{
  const iframe=document.querySelector<HTMLIFrameElement>('#panel');
  if(event.origin!==location.origin||event.source!==iframe?.contentWindow)return;
  if(event.data?.kind==='fixture/settings')window.dispatchEvent(new CustomEvent('kollens:settings',{detail:event.data.settings}));
});
window.addEventListener('kollens:focus',event=>{const iframe=document.querySelector<HTMLIFrameElement>('#panel');if(iframe){iframe.hidden=false;document.querySelector('#toggle-popup')?.setAttribute('aria-expanded','true');iframe.contentWindow?.postMessage({kind:'fixture/focus',groupId:(event as CustomEvent).detail},location.origin);}});
if(!new URLSearchParams(location.search).has('extension'))void import('./content');
else{document.querySelector('#panel')?.remove();(document.querySelector('.layout')as HTMLElement).style.gridTemplateColumns='1fr';}
