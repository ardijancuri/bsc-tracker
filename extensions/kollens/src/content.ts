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
const fixture=['127.0.0.1','localhost'].includes(location.hostname)&&location.pathname==='/fixture';
const style=document.createElement('style');style.setAttribute('data-kollens-decoration','');
style.textContent='.kollens-match{outline:2px solid var(--kollens-match-color)!important;outline-offset:-2px!important}[data-kollens-social-match]{outline:1px solid var(--kollens-social-color)!important;outline-offset:2px!important;border-radius:2px!important}';
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
function route(){
  if(!running||suspended||isExtension&&!extensionId())return;
  const layout=fixture?fixtureLayout:(config.localGmgnLive||config.gmgnAuthorized)&&isBscTrenches(location.href)?verifiedGmgnLayout:null;
  let root=layout?document.querySelector<HTMLElement>(layout.root):null;
  if(root&&layout?.cardContainer&&!root.querySelector(layout.cardContainer))root=null;
  if(root!==currentRoot||currentUrl!==location.href){
    controller?.destroy();controller=null;currentRoot=root;currentUrl=location.href;
    if(root&&layout)controller=new TrenchesController(root,layout,send,focus,()=>location.href,lastSettings??undefined);
    else send({pageId:crypto.randomUUID(),status:layout?'unsupported':'disabled',cards:[],groups:[],alerts:[],active:!document.hidden,updatedAt:Date.now(),url:location.href,durations:[]});
  }
}
const observer=new MutationObserver(route);
function resume(){if(!running||routeTimer!==undefined&&!suspended)return;suspended=false;currentRoot=null;currentUrl='';document.head.append(style);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-chain','data-testid']});routeTimer=setInterval(route,250);route();}
function suspend(){suspended=true;observer.disconnect();clearInterval(routeTimer);routeTimer=undefined;controller?.destroy();controller=null;style.remove();}
function destroy(){
  if(!running)return;
  running=false;
  suspend();
  if(isExtension){
    try{browserApi.runtime?.onMessage?.removeListener(onMessage);}catch{/* Page cleanup still has to finish. */}
  }else window.removeEventListener('kollens:settings',demoSettings);
  window.removeEventListener('pagehide',onHide);
  window.removeEventListener('pageshow',onShow);
  window.removeEventListener('popstate',route);
  window.removeEventListener('hashchange',route);
  if(isolated.__kollensContent===instance)delete isolated.__kollensContent;
}
function settings(message:{kind:string;preferences?:ExtensionPreferences;saved?:string[];groupId?:string|null}){
  if(message.kind==='settings'&&message.preferences){lastSettings={preferences:message.preferences,saved:message.saved??[]};controller?.settings(message.preferences,message.saved??[]);}
  if(message.kind==='select')controller?.select(message.groupId??null);
  if(message.kind==='request-page'){route();controller?.flush();}
  if(message.kind==='stop-gmgn'&&!fixture)destroy();
}
function onMessage(message:any,sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void){const id=extensionId();if(!id||sender.id!==id||sender.tab)return;settings(message);respond({ok:true});}
function demoSettings(event:Event){settings((event as CustomEvent).detail);}
function onHide(){suspend();}
function onShow(event:PageTransitionEvent){if(event.persisted)void start();}
const instance={destroy};isolated.__kollensContent=instance;
if(isExtension){
  try{browserApi.runtime.onMessage.addListener(onMessage);}catch{retire();}
}else window.addEventListener('kollens:settings',demoSettings);
window.addEventListener('pagehide',onHide);window.addEventListener('pageshow',onShow);window.addEventListener('popstate',route);window.addEventListener('hashchange',route);
async function start(){
  if(isExtension&&!fixture){const initial=await sendToBackground({kind:'content-settings'});if(!initial?.preferences){destroy();return;}lastSettings=initial;}
  if(running&&!invalidated)resume();
}
void start();
