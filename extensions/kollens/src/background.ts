import { browserApi as chrome, config } from './platform';
import { WorkspaceSync, type LocalStore } from './sync';
import { isBscTrenches } from './adapter';
import { readRenderedGmgnTrenches } from './gmgnReader';
import { normalizeCardMetric } from './cardMetrics';
import { normalizeSocialLink, matchCards } from './matching';
import {LiveGmgnAccess,gmgnOrigins} from './liveAccess';
import {extensionTokenImageUrl,type ExtensionAuthOptions,type ExtensionPage} from '../../../shared/extension';

const store:LocalStore={async get<T>(key:string){return (await chrome.storage.local.get(key))[key] as T|undefined;},async set(key,value){await chrome.storage.local.set({[key]:value});}};
const live=new LiveGmgnAccess(chrome,config.localGmgnLive);
const ready=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).then(()=>live.restore().catch(()=>{live.enabled=false;}));
const sync=new WorkspaceSync(config.apiOrigin,store),pages=new Map<number,ExtensionPage>(),selections=new Map<number,string>();
const configuredPages=new Map<number,string>();
const settingsVersions=new Map<number,string>();
const sidePanelUrl=chrome.runtime.getURL('sidepanel.html');
const uiUrls=new Set([chrome.runtime.getURL('popup.html'),chrome.runtime.getURL('panel.html'),sidePanelUrl]);
const focusRequests=new Set<number>();
const manualPages=new Set<number>();
let authOptions: ExtensionAuthOptions | undefined;
let authOptionsRetryAt = 0;
let socialError: {ownerId: string; message: string} | null = null;
const socialErrors = new Set([
  'An account link is already in progress.', 'Could not start the account link. Try again.', 'Account linking was interrupted. Try again.',
  'Account linking was cancelled.', 'Could not verify the account link. Try again.', 'This account already has a link, or the profile is linked elsewhere.',
]);
function loadAuthOptions() {
  if (Date.now() < authOptionsRetryAt) return;
  authOptionsRetryAt = Date.now() + 20_000;
  void sync.authOptions().then(options => {
    authOptions = options;
    authOptionsRetryAt = Date.now() + 300_000;
  }, () => {});
}
chrome.runtime.onInstalled.addListener(({reason})=>{
  if(reason==='update')void ready.then(()=>live.enabled?live.setEnabled(true):undefined).catch(()=>{});
});
function gmgnSender(sender:any){
  if(sender.id!==chrome.runtime.id||!sender.tab||sender.frameId!==0||!live.enabled)return false;
  try{return['https://gmgn.ai','https://www.gmgn.ai'].includes(new URL(sender.url).origin);}catch{return false;}
}
function contentSender(sender:any){
  if(sender.id!==chrome.runtime.id||!sender.tab||sender.frameId!==0)return false;
  try{const url=new URL(sender.url);return gmgnSender(sender)||config.gmgnAuthorized&&isBscTrenches(url.href)
    || __LOCAL_FIXTURE__&&url.origin==='http://127.0.0.1:3360'&&url.pathname==='/fixture';}catch{return false;}
}
declare const __LOCAL_FIXTURE__:boolean;
async function active(){return(await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id as number|undefined;}
async function activeUiTab(sender:chrome.runtime.MessageSender,windowId:unknown) {
  if (sender.url?.split('?')[0]!==sidePanelUrl) {
    return (await chrome.tabs.query({active:true,currentWindow:true}))[0];
  }
  // This URL has already passed the extension-page sender check. Chrome can
  // omit its document context or report -1 for a global side panel, so keep
  // the window reported by that panel rather than using the worker's window.
  const [context] = sender.documentId
    ? await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL'],documentIds:[sender.documentId]}).catch(()=>[])
    : [];
  const owningWindow = context && context.windowId>=0?context.windowId:windowId;
  if (typeof owningWindow==='number'&&Number.isInteger(owningWindow)&&owningWindow>=0) {
    return (await chrome.tabs.query({active:true,windowId:owningWindow}))[0];
  }
}
async function pushSettings(tabId:number){const settings=await sync.settings(),version=(pages.get(tabId)?.pageId??'')+JSON.stringify(settings);if(settingsVersions.get(tabId)===version)return;settingsVersions.set(tabId,version);if(manualPages.has(tabId)){const page=pages.get(tabId);if(page)page.groups=matchCards(page.cards,settings.preferences.matchTypes);return;}await chrome.tabs.sendMessage(tabId,{kind:'settings',...settings,preferences:{...settings.preferences,sound:settings.preferences.sound&&settings.soundActivated}}).catch(()=>{settingsVersions.delete(tabId);});}
async function refreshTabs(){await Promise.all([...pages.keys()].map(pushSettings));}
async function scanTrenches(tabId:number,url:string) {
  const [snapshot] = await chrome.scripting.executeScript({
    target:{tabId,frameIds:[0]},world:'ISOLATED',func:readRenderedGmgnTrenches,
  });
  const raw = snapshot?.result;
  if (!raw || raw.url!==url) return;
  const settings = await sync.settings();
  const after = await chrome.tabs.get(tabId);
  if (!after.active || after.url!==url || live.enabled) return;

  const pageId = crypto.randomUUID();
  const cards = raw.cards.map((card,index)=>({
    chainId:56 as const,address:card.address,name:card.name,symbol:card.symbol,
    logoUrl:extensionTokenImageUrl(card.logoUrl),tokenUrl:card.tokenUrl,cardId:`${pageId}:${index}`,
    socialLinks:card.socialUrls.map(normalizeSocialLink).filter(link=>link!==null),
    marketCap:normalizeCardMetric(card.marketCap),volume:normalizeCardMetric(card.volume),
  }));
  pages.set(tabId,{pageId,status:raw.status,url:raw.url,cards,groups:matchCards(cards,settings.preferences.matchTypes),
    alerts:[],active:true,updatedAt:raw.observedAt,durations:[]});
  manualPages.add(tabId);
  selections.delete(tabId);
}
let lastSound=-Infinity;
let audioError:string|null=null;
async function sound(){
  if(Date.now()-lastSound<30_000)return;lastSound=Date.now();
  try{
    if(!await chrome.offscreen.hasDocument())await chrome.offscreen.createDocument({url:'audio.html',reasons:['AUDIO_PLAYBACK'],justification:'Play an opted-in matching alert sound'});
    const result=await chrome.runtime.sendMessage({kind:'audio/beep'});
    audioError=result?.played?null:'Chrome paused alert audio. Toggle sound in the extension to try again.';
  }catch{audioError='Chrome paused alert audio. Visual alerts remain available.';}
}
chrome.tabs.onRemoved.addListener((id:number)=>{pages.delete(id);manualPages.delete(id);selections.delete(id);configuredPages.delete(id);settingsVersions.delete(id);});
chrome.tabs.onUpdated.addListener((id:number,info:any)=>{if(info.status==='loading'||info.url&&pages.get(id)?.url!==info.url){pages.delete(id);manualPages.delete(id);selections.delete(id);configuredPages.delete(id);settingsVersions.delete(id);}});
chrome.permissions.onRemoved.addListener(()=>{void ready.then(async()=>{if(live.enabled&&!await chrome.permissions.contains({origins:gmgnOrigins})){await live.setEnabled(false);for(const [id,page]of pages)if(isBscTrenches(page.url)){pages.delete(id);settingsVersions.delete(id);}}}).catch(()=>{});});
chrome.runtime.onMessage.addListener((message:any,sender:any,respond:(value:unknown)=>void)=>{
  if(message?.kind==='audio/beep')return false;
  const canFocus=message?.kind==='focus'&&contentSender(sender)&&pages.get(sender.tab.id)?.groups.some(g=>g.id===message.groupId);
  if(canFocus){selections.set(sender.tab.id,message.groupId);focusRequests.add(sender.tab.id);}
  const opening=canFocus?chrome.action.openPopup({windowId:sender.tab.windowId}):null;
  if(opening)void opening.catch(()=>{});
  const work=async()=>{
    await ready;
    // A dormant script must survive an initial non-BSC route, then activate only
    // when the user navigates to BSC trenches. No non-BSC card data is accepted.
    if(gmgnSender(sender)&&message.kind==='content-settings'){const settings=await sync.settings();return{...settings,preferences:{...settings.preferences,sound:settings.preferences.sound&&settings.soundActivated}};}
    if(contentSender(sender)){
      const tabId=sender.tab.id;
      if(message.kind==='content-settings'){const settings=await sync.settings();return{...settings,preferences:{...settings.preferences,sound:settings.preferences.sound&&settings.soundActivated}};}
      if(message.kind==='page'){
        const page=message.page as ExtensionPage;
        if(!page||page.cards?.length>2000||page.groups?.length>8000||page.alerts?.length>50||typeof page.pageId!=='string')throw new Error('Invalid page snapshot');
        if(gmgnSender(sender)){
          // Chrome retains the injection URL in sender.url across pushState.
          // Validate the current tab independently rather than trusting that URL
          // or accepting a page-supplied chain change by itself.
          const current=await chrome.tabs.get(tabId);
          if(!live.enabled||!isBscTrenches(current.url??'')){pages.delete(tabId);selections.delete(tabId);return{ok:true};}
          if(page.url!==current.url)return{ok:true};
        }
        pages.set(tabId,page);
        void chrome.runtime.sendMessage({kind:'panel/changed'}).catch(()=>{});
        if(configuredPages.get(tabId)!==page.pageId){configuredPages.set(tabId,page.pageId);await pushSettings(tabId);}
        const audio=await sync.settings();
        if(message.sound&&page.active&&await active()===tabId&&audio.preferences.sound&&audio.soundActivated)await sound();
        return {ok:true};
      }
      if(message.kind==='focus'&&pages.get(tabId)?.groups.some(g=>g.id===message.groupId)){
        selections.set(tabId,message.groupId);if(opening)await opening;void chrome.runtime.sendMessage({kind:'panel/focus',groupId:message.groupId}).catch(()=>{});return{ok:true};
      }
      throw new Error('Content request rejected');
    }
    if(sender.id!==chrome.runtime.id||!uiUrls.has(sender.url?.split('?')[0]))throw new Error('Request context rejected');
    if(message.ownerId!==undefined&&message.ownerId!==(await sync.state()).ownerId)throw new Error('Account changed');
    switch(message.kind){
      case 'state':{
        // Storage and popup navigation stay available while a provider or the API is slow.
        void sync.sync();
        loadAuthOptions();
        const tab=await activeUiTab(sender,message.windowId).catch(()=>undefined),tabId=tab?.id;
        const tabUrl=tab?.url??'';
        const canScanPage=isBscTrenches(tabUrl);
        // The toolbar click already grants temporary activeTab access. Regular
        // state polling does not inject a reader.
        if(message.scanActiveTab===true&&tabId!=null&&canScanPage&&!live.enabled&&!config.gmgnAuthorized){
          await scanTrenches(tabId,tabUrl).catch(()=>{});
        }else if(tabId!=null&&!pages.has(tabId)){
          void chrome.tabs.sendMessage(tabId,{kind:'request-page'}).catch(()=>{});
        }
        const state=await sync.state();
        void refreshTabs().catch(()=>{});
        const focusRequested=sender.url?.split('?')[0]!==sidePanelUrl&&tabId!=null&&focusRequests.delete(tabId);
        const linkError = state.connected && socialError?.ownerId === state.ownerId ? socialError.message : null;
        return{...state,...await sync.settings(),authOptions,demoAccount:__LOCAL_FIXTURE__,focusRequested,error:state.error??linkError??audioError,page:tabId==null?null:pages.get(tabId)??null,selected:tabId==null?null:selections.get(tabId)??null,gmgnAuthorized:config.gmgnAuthorized,canScanPage,manualPage:tabId!=null&&manualPages.has(tabId),localLiveAvailable:config.localGmgnLive,liveEnabled:live.enabled};
      }
      case 'enable-live':await live.setEnabled(true);manualPages.clear();break;
      case 'connect':await sync.connect(async url=>{await chrome.tabs.create({url});});break;
      case 'google-connect':
        await sync.googleConnect(url=>chrome.identity.launchWebAuthFlow({url,interactive:true}),chrome.identity.getRedirectURL('kollens'));
        break;
      case 'email-start':
        if (typeof message.email!=='string' || message.email.length>254) throw Error('Enter a valid email address.');
        await sync.startEmail(message.email);break;
      case 'email-verify':
        if (typeof message.email!=='string' || message.email.length>254 || !/^\d{6}$/.test(message.code)) throw Error('Enter the six-digit code.');
        await sync.verifyEmail(message.email,message.code);break;
      case 'link-social': {
        if (message.provider!=='telegram' && message.provider!=='x') throw Error('Invalid social provider');
        const ownerId = (await sync.state()).ownerId;
        socialError = null;
        try {
          await sync.linkSocial(message.provider,url=>chrome.identity.launchWebAuthFlow({url,interactive:true}),chrome.identity.getRedirectURL('kollens'));
        } catch (error) {
          if (ownerId === (await sync.state()).ownerId) {
            const message = error instanceof Error && socialErrors.has(error.message) ? error.message : 'Could not verify the account link. Try again.';
            socialError = {ownerId,message};
          }
          throw error;
        }
        break;
      }
      case 'cancel-pairing':await sync.cancelPairing();return {ok:true};
      case 'disconnect':await sync.disconnect();socialError=null;break;
      case 'edit':await sync.edit(message.item,message.action??'save',message.field);break;
      case 'resolve':await sync.resolve(message.address,message.choice);break;
      case 'preferences':await sync.preferences(message.preferences,message.activateSound===true);break;
      case 'resolvePreferences':await sync.resolvePreferences(message.choice);break;
      case 'ui':await sync.rememberUi(message.ownerId,message.patch);return{ok:true};
      case 'select':{const tabId=(await activeUiTab(sender,message.windowId))?.id;if(tabId!=null&&pages.get(tabId)?.groups.some(g=>g.id===message.groupId)){
        selections.set(tabId,message.groupId);if(!manualPages.has(tabId))await chrome.tabs.sendMessage(tabId,{kind:'select',groupId:message.groupId});}break;}
      default:throw new Error('Unknown extension request');
    }
    if(message.kind!=='connect')await sync.sync();await refreshTabs();return{ok:true};
  };
  void work().then(respond,(error:unknown)=>{
    console.warn('extension_request_failed',{kind:message?.kind,errorName:error instanceof Error?error.name:'unknown',frame:error instanceof Error?error.stack?.split('\n')[1]:undefined});
    const safe=new Set(['Try again shortly','Connect your Kollens account first','Notes are limited to 2,000 characters','Save up to 100 tokens','Resolve this note conflict before saving again','Connection expired. Connect again.','Allow GMGN site access first',
      'Log out before connecting another account.','A sign-in is already in progress.','Could not start connection. Try again.','Sign-in was cancelled.',
      'Could not complete Google sign-in. Try again.','Google sign-in was cancelled.','Enter a valid email address.','Enter the six-digit code.',
      'Wait before requesting another code.','Could not send a sign-in code. Try again.','Request a new sign-in code.','The code is invalid or has expired.']);
    respond({error:error instanceof Error&&(safe.has(error.message)||socialErrors.has(error.message))?error.message:'The extension request could not complete. Your local drafts are retained.'});
  });return true;
});
