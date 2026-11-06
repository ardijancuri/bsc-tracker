import { fixtureLayout, verifiedGmgnLayout, isBscTrenches } from './adapter';
import { TrenchesController } from './controller';
import { config, isExtension, browserApi } from './platform';
import type { ExtensionPage, ExtensionPreferences } from '../../../shared/extension';

type Settings={preferences:ExtensionPreferences;saved:string[]};
type ContentGlobal=typeof globalThis&{__kollensContent?:{destroy():void}};
const isolated=globalThis as ContentGlobal;
// Chrome can invalidate the previous script's runtime during a reload.
try { isolated.__kollensContent?.destroy(); } catch { /* Continue with the new context. */ }
let controller:TrenchesController|null=null,currentRoot:HTMLElement|null=null,currentUrl='',running=true,suspended=false;
let lastSettings:Settings|null=null,routeTimer:ReturnType<typeof setInterval>|undefined;
const startupDelays=[80,240,640];
const layoutGraceMs=2_000;
let missingLayout:{pageId:string;since:number;status?:ExtensionPage['status']}|null=null;
let startupTimer:ReturnType<typeof setTimeout>|undefined,startupEpoch=0,startupAttempt=0,starting=false;
const fixture=['127.0.0.1','localhost'].includes(location.hostname)&&location.pathname==='/fixture';
const style=document.createElement('style');style.setAttribute('data-kollens-decoration','');
style.textContent = `
  .kollens-match:not(:focus-visible) {
    border-radius: 8px !important;
    outline: 2px solid var(--kollens-match-color) !important;
    outline-offset: -3px !important;
  }
  [data-kollens-social-match]:not(:focus-visible):not(:has(> :is(svg, img):only-child)),
  [data-kollens-social-match]:not(:focus-visible) > :is(svg, img):only-child {
    border-radius: 4px !important;
    outline: 1px solid var(--kollens-social-color) !important;
    outline-offset: 1px !important;
  }
`;
let invalidated=false;
function retire(){
  if(invalidated)return;
  invalidated=true;
  // The controller can publish while its constructor is still running.
  queueMicrotask(destroy);
}
function extensionId(){
  if(invalidated)return undefined;
  try{const id=browserApi.runtime?.id;if(id)return id;}catch{/* The old context may no longer expose runtime. */}
  retire();
  return undefined;
}
async function sendToBackground(message:unknown){
  if(!extensionId())return;
  try{return await browserApi.runtime.sendMessage(message);}
  catch(error){
    // Chrome can throw synchronously here or reject the returned promise.
    if(/extension context invalidated/i.test(error instanceof Error?error.message:String(error)))retire();
    return undefined;
  }
}
function send(page:ExtensionPage,sound=false){
  if(isExtension)void sendToBackground({kind:'page',page,sound});
  else window.dispatchEvent(new CustomEvent('kollens:page',{detail:{page,sound}}));
}
function focus(groupId:string){
  if(isExtension)void sendToBackground({kind:'focus',groupId});
  else window.dispatchEvent(new CustomEvent('kollens:focus',{detail:groupId}));
}
function route(republish=false){
  if(!running||suspended||isExtension&&!extensionId())return;
  const url=location.href;
  const layout=fixture?fixtureLayout:(config.localGmgnLive||config.gmgnAuthorized)&&isBscTrenches(url)?verifiedGmgnLayout:null;
  let root=layout?document.querySelector<HTMLElement>(layout.root):null;
  if(root&&layout?.cardContainer&&!root.querySelector(layout.cardContainer))root=null;
  if(root!==currentRoot||currentUrl!==url){
    controller?.destroy();controller=null;currentRoot=root;currentUrl=url;missingLayout=null;
    if(root&&layout)controller=new TrenchesController(root,layout,send,focus,()=>location.href,lastSettings??undefined);
  }
  if(root)return;
  const now=Date.now();
  missingLayout??={pageId:crypto.randomUUID(),since:now};
  const status=!layout?'disabled':layout===verifiedGmgnLayout&&now-missingLayout.since<layoutGraceMs?'waiting':'unsupported';
  if(!republish&&missingLayout.status===status)return;
  missingLayout.status=status;
  send({pageId:missingLayout.pageId,status,cards:[],groups:[],alerts:[],active:!document.hidden,updatedAt:now,url,durations:[]});
}
const onRoute=()=>route();
const observer=new MutationObserver(onRoute);
function resume(){if(!running||routeTimer!==undefined&&!suspended)return;suspended=false;currentRoot=null;currentUrl='';document.head.append(style);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-chain','data-testid']});routeTimer=setInterval(onRoute,250);route();}
function suspend(){
  suspended=true;
  startupEpoch++;
  starting=false;startupAttempt=0;
  if(startupTimer!==undefined)clearTimeout(startupTimer);
  startupTimer=undefined;
  observer.disconnect();clearInterval(routeTimer);routeTimer=undefined;controller?.destroy();controller=null;style.remove();
}
function destroy(){
  if(!running)return;
  running=false;
  suspend();
  if(isExtension){
    try{browserApi.runtime?.onMessage?.removeListener(onMessage);}catch{/* Page cleanup still has to finish. */}
  }else window.removeEventListener('kollens:settings',demoSettings);
  window.removeEventListener('pagehide',onHide);
  window.removeEventListener('pageshow',onShow);
  window.removeEventListener('popstate',onRoute);
  window.removeEventListener('hashchange',onRoute);
  if(isolated.__kollensContent===instance)delete isolated.__kollensContent;
}
function settings(message:{kind:string;preferences?:ExtensionPreferences;saved?:string[];groupId?:string|null}){
  if(message.kind==='settings'&&message.preferences){lastSettings={preferences:message.preferences,saved:message.saved??[]};controller?.settings(message.preferences,message.saved??[]);}
  if(message.kind==='select')controller?.select(message.groupId??null);
  if(message.kind==='request-page'){if(routeTimer===undefined)void start();else{route(true);controller?.flush();}}
  if(message.kind==='stop-gmgn'&&!fixture)destroy();
}
function onMessage(message:any,sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void){const id=extensionId();if(!id||sender.id!==id||sender.tab)return;settings(message);respond({ok:true});}
function demoSettings(event:Event){settings((event as CustomEvent).detail);}
function onHide(){suspend();}
function onShow(event:PageTransitionEvent){if(event.persisted){suspended=false;void start();}}
const instance={destroy};isolated.__kollensContent=instance;
if(isExtension){
  try{browserApi.runtime.onMessage.addListener(onMessage);}catch{retire();}
}else window.addEventListener('kollens:settings',demoSettings);
window.addEventListener('pagehide',onHide);window.addEventListener('pageshow',onShow);window.addEventListener('popstate',onRoute);window.addEventListener('hashchange',onRoute);
async function start(){
  if(!running||invalidated||suspended||starting||startupTimer!==undefined||routeTimer!==undefined)return;
  if(isExtension&&!fixture){
    const epoch=startupEpoch;
    starting=true;
    const initial=await sendToBackground({kind:'content-settings'});
    if(epoch!==startupEpoch)return;
    starting=false;
    if(!running||invalidated)return;
    if(!initial?.preferences){
      const delay=startupDelays[startupAttempt++];
      if(delay===undefined){destroy();return;}
      startupTimer=setTimeout(()=>{startupTimer=undefined;void start();},delay);
      return;
    }
    lastSettings=initial;
    startupAttempt=0;
  }
  resume();
}
void start();
