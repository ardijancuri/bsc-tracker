import { browserApi as chrome, config } from './platform';
import { WorkspaceSync, type LocalStore } from './sync';
import { isBscTrenches, verifiedGmgnLayout } from './adapter';
import { readRenderedGmgnTrenches } from './gmgnReader';
import { gmgnNarrativeAddress, gmgnNarrativeOrigin, readRenderedGmgnNarrative, type GmgnNarrative } from './gmgnNarrative';
import { normalizeCardMetric } from './cardMetrics';
import { normalizeSocialLink, matchCards } from './matching';
import {LiveGmgnAccess,gmgnOrigins} from './liveAccess';
import { isXPage, loadXTrendingTokens, refreshXTrendingAccess, xTrendingOrigins, xTrendingSiteAllowed } from './xTrendingAccess';
import {extensionAddress,extensionTokenImageUrl,type ExtensionAuthOptions,type ExtensionPage} from '../../../shared/extension';

const store:LocalStore={async get<T>(key:string){return (await chrome.storage.local.get(key))[key] as T|undefined;},async set(key,value){await chrome.storage.local.set({[key]:value});}};
const live=new LiveGmgnAccess(chrome,config.localGmgnLive);
const ready=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).then(()=>live.restore().catch(()=>{live.enabled=false;}));
void ready.then(()=>live.recoverOpenTabs()).catch(()=>{});
void refreshXTrendingAccess().catch(()=>{});
const sync=new WorkspaceSync(config.apiOrigin,store),pages=new Map<number,ExtensionPage>(),selections=new Map<number,string>();
const configuredPages=new Map<number,string>();
const settingsVersions=new Map<number,string>();
const sidePanelUrl=chrome.runtime.getURL('sidepanel.html');
const uiUrls=new Set([chrome.runtime.getURL('popup.html'),chrome.runtime.getURL('panel.html'),sidePanelUrl]);
const focusRequests=new Set<number>();
const manualPages=new Set<number>();
const manualScans=new Map<number,{url:string;promise:Promise<void>}>();
const manualSnapshotReuseMs=750;
type ReadyNarrative = Extract<GmgnNarrative, { status: 'ready' }>;
const narrativeCache = new Map<string, { value: ReadyNarrative; expires: number }>();
let readingNarrative: {
  key: string;
  result: Promise<chrome.scripting.InjectionResult<GmgnNarrative>[]>;
  invalidated: boolean;
} | undefined;
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
  if(reason==='update')void refreshXTrendingAccess(true).catch(()=>{});
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
declare const __GMGN_NARRATIVE_LOCAL__: boolean;
declare const __GMGN_NARRATIVE_FRAME_TEST__: boolean;
async function active(){return(await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id as number|undefined;}
async function activeUiTab(sender:chrome.runtime.MessageSender,windowId:unknown) {
  if (sender.url?.split('?')[0]!==sidePanelUrl) {
    const query=typeof windowId==='number'&&Number.isInteger(windowId)&&windowId>=0
      ? {active:true,windowId} : {active:true,currentWindow:true};
    return (await chrome.tabs.query(query))[0];
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

async function loadGroupNarrative(tab: chrome.tabs.Tab | undefined, groupId: unknown, address: unknown): Promise<GmgnNarrative> {
  if (!tab || tab.id == null || !tab.url || !extensionAddress(address)) return { status: 'group_changed' };
  const { id: tabId, url } = tab;
  const direct = groupId === undefined && gmgnNarrativeAddress(url) === address;
  const groupIsCurrent = () => {
    const page = pages.get(tabId);
    return direct || (page?.url === url && isBscTrenches(url)
      && page.groups.some(group => group.id === groupId && group.addresses.includes(address)));
  };
  if (!groupIsCurrent()) return { status: 'group_changed' };
  const origin = new URL(url).hostname === 'www.gmgn.ai' ? 'https://www.gmgn.ai/*' : gmgnNarrativeOrigin;
  if (!await chrome.permissions.contains({ origins: [origin] })) return { status: 'access_required' };

  const key = `${tabId}\n${url}\n${address}`;
  const cached = narrativeCache.get(key);
  const cachedValue = cached && cached.expires > Date.now() ? cached.value : undefined;
  if (!cachedValue && readingNarrative && (readingNarrative.key !== key || readingNarrative.invalidated)) {
    return { status: 'busy' };
  }
  let ownsRead = false;
  let read: typeof readingNarrative;
  try {
    let result: GmgnNarrative | undefined = cachedValue;
    if (!result) {
      if (!readingNarrative) {
        // Only builds explicitly selected for local testing use the frame fallback.
        const allowDetailFrame = __GMGN_NARRATIVE_FRAME_TEST__ && !direct;
        readingNarrative = {
          key,
          invalidated: false,
          result: chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'ISOLATED',
            func: readRenderedGmgnNarrative,
            args: [address, url, Date.now() + (direct ? 9000 : allowDetailFrame ? 14000 : 5000),
              direct ? null : verifiedGmgnLayout, allowDetailFrame],
          }),
        };
        ownsRead = true;
      }
      read = readingNarrative;
      const [injection] = await read.result;
      result = injection?.result;
    }
    const current = await chrome.tabs.get(tabId);
    if (!current.active || current.url !== url || !groupIsCurrent() || read?.invalidated
      || (cachedValue && narrativeCache.get(key) !== cached)) return { status: 'group_changed' };
    if (!cachedValue && result?.status === 'ready' && narrativeCache.get(key)?.value !== result) {
      narrativeCache.delete(key);
      narrativeCache.set(key, { value: result, expires: Date.now() + 5 * 60_000 });
      if (narrativeCache.size > 64) {
        const oldest = narrativeCache.keys().next().value;
        if (oldest !== undefined) narrativeCache.delete(oldest);
      }
    }
    return result ?? { status: 'page_unavailable' };
  } catch {
    return { status: 'page_unavailable' };
  } finally {
    if (ownsRead) readingNarrative = undefined;
  }
}
function invalidateNarratives(tabId?: number) {
  const prefix = tabId === undefined ? '' : `${tabId}\n`;
  for (const key of narrativeCache.keys()) if (key.startsWith(prefix)) narrativeCache.delete(key);
  if (readingNarrative?.key.startsWith(prefix)) readingNarrative.invalidated = true;
}
async function pushSettings(tabId:number){const settings=await sync.settings(),version=(pages.get(tabId)?.pageId??'')+JSON.stringify(settings);if(settingsVersions.get(tabId)===version)return;settingsVersions.set(tabId,version);if(manualPages.has(tabId)){const page=pages.get(tabId);if(page)page.groups=matchCards(page.cards,settings.preferences.matchTypes);return;}await chrome.tabs.sendMessage(tabId,{kind:'settings',...settings,preferences:{...settings.preferences,sound:settings.preferences.sound&&settings.soundActivated}}).catch(()=>{settingsVersions.delete(tabId);});}
async function refreshTabs(){await Promise.all([...pages.keys()].map(pushSettings));}
function notifyPageChanged(tabId:number) {
  void chrome.runtime.sendMessage({kind:'panel/changed',tabId}).catch(()=>{});
}
function scanTrenches(tabId:number,url:string):Promise<void> {
  const existing=manualScans.get(tabId);
  if(existing?.url===url)return existing.promise;
  let firstReadDone!:()=>void;
  const promise=new Promise<void>(resolve=>{firstReadDone=resolve;});
  const request={url,promise};
  const isCurrent=()=>manualScans.get(tabId)===request&&!live.enabled;
  manualScans.set(tabId,request);
  void (async()=>{
    // A toolbar snapshot can start before the SPA has mounted the trenches.
    // Retry only this active-tab request, and stop as soon as the reader is ready.
    const retryDelays=[0,100,250,500,650,650];
    for(const [attempt,delay] of retryDelays.entries()){
      const finalAttempt=attempt===retryDelays.length-1;
      if(delay)await new Promise<void>(resolve=>setTimeout(resolve,delay));
      if(!isCurrent())return;
      const current=await chrome.tabs.get(tabId);
      if(!current.active||current.url!==url||!isCurrent())return;
      const [snapshot]=await chrome.scripting.executeScript({
        target:{tabId,frameIds:[0]},world:'ISOLATED',func:readRenderedGmgnTrenches,
      });
      const raw=snapshot?.result;
      if(!raw||raw.url!==url||!isCurrent())return;
      if(raw.status!=='ready'&&!finalAttempt){
        firstReadDone();
        continue;
      }
      const [settings,after]=await Promise.all([sync.settings(),chrome.tabs.get(tabId)]);
      if(!after.active||after.url!==url||!isCurrent())return;

      const previous=manualPages.has(tabId)?pages.get(tabId):undefined;
      const pageId=previous?.url===url?previous.pageId:crypto.randomUUID();
      const cards=raw.cards.map((card,index)=>({
        chainId:56 as const,address:card.address,name:card.name,symbol:card.symbol,
        logoUrl:extensionTokenImageUrl(card.logoUrl),tokenUrl:card.tokenUrl,cardId:pageId+':'+index,
        socialLinks:card.socialUrls.map(normalizeSocialLink).filter(link=>link!==null),
        marketCap:normalizeCardMetric(card.marketCap),volume:normalizeCardMetric(card.volume),
      }));
      const groups=matchCards(cards,settings.preferences.matchTypes);
      pages.set(tabId,{pageId,status:raw.status,url:raw.url,cards,groups,
        alerts:[],active:true,updatedAt:raw.observedAt,durations:[]});
      manualPages.add(tabId);
      if(previous?.pageId!==pageId||!groups.some(group=>group.id===selections.get(tabId)))selections.delete(tabId);
      firstReadDone();
      if(cards.length||finalAttempt)return;
      notifyPageChanged(tabId);
    }
  })().catch(()=>{}).finally(()=>{
    if(manualScans.get(tabId)===request){
      manualScans.delete(tabId);
      notifyPageChanged(tabId);
    }
    firstReadDone();
  });
  return request.promise;
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
function forgetPage(id:number) {
  pages.delete(id);manualPages.delete(id);manualScans.delete(id);selections.delete(id);
  configuredPages.delete(id);settingsVersions.delete(id);focusRequests.delete(id);
  if (__GMGN_NARRATIVE_LOCAL__) invalidateNarratives(id);
}
chrome.tabs.onRemoved.addListener(forgetPage);
chrome.tabs.onUpdated.addListener((id,info,tab)=>{
  if(info.status==='loading'||info.url&&pages.get(id)?.url!==info.url)forgetPage(id);
  if(isXPage(info.url))void chrome.tabs.sendMessage(id,{kind:'x-trending/navigation'}).catch(async()=>{
    if(isXPage(tab.url)&&await xTrendingSiteAllowed()){
      await chrome.scripting.executeScript({target:{tabId:id,frameIds:[0]},world:'ISOLATED',files:['x-trending.js']});
    }
  }).catch(()=>{});
  if(info.url||info.status==='complete')void ready.then(()=>{
    if(live.enabled&&!pages.has(id))return live.recoverTab(tab);
  }).catch(()=>{});
});
chrome.tabs.onActivated.addListener(({tabId})=>{
  void ready.then(async()=>{
    if(live.enabled&&!pages.has(tabId))await live.recoverTab(await chrome.tabs.get(tabId));
  }).catch(()=>{});
});
chrome.permissions.onRemoved.addListener(()=>{void ready.then(async()=>{if(live.enabled&&!await chrome.permissions.contains({origins:gmgnOrigins})){await live.setEnabled(false);for(const [id,page]of pages)if(isBscTrenches(page.url))forgetPage(id);}}).catch(()=>{});});
chrome.permissions.onAdded.addListener(({origins})=>{
  if(origins?.some(origin=>xTrendingOrigins.includes(origin)))void refreshXTrendingAccess().catch(()=>{});
});
chrome.permissions.onRemoved.addListener(({origins})=>{
  if(origins?.some(origin=>xTrendingOrigins.includes(origin)))void refreshXTrendingAccess().catch(()=>{});
  if (__GMGN_NARRATIVE_LOCAL__ && origins?.some(origin => gmgnOrigins.includes(origin))) invalidateNarratives();
});
chrome.runtime.onMessage.addListener((message:any,sender:any,respond:(value:unknown)=>void)=>{
  if(message?.kind==='audio/beep')return false;
  const canFocus=message?.kind==='focus'&&contentSender(sender)&&pages.get(sender.tab.id)?.groups.some(g=>g.id===message.groupId);
  if(canFocus){selections.set(sender.tab.id,message.groupId);focusRequests.add(sender.tab.id);}
  const opening=canFocus?chrome.action.openPopup({windowId:sender.tab.windowId}):null;
  if(opening)void opening.catch(()=>{});
  const work=async()=>{
    if(message?.kind==='x-trending/tokens')return loadXTrendingTokens(message.window,sender);
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
          if(!live.enabled||!isBscTrenches(current.url??'')){forgetPage(tabId);return{ok:true};}
          if(page.url!==current.url)return{ok:true};
        }
        manualPages.delete(tabId);
        pages.set(tabId,page);
        notifyPageChanged(tabId);
        if(configuredPages.get(tabId)!==page.pageId){configuredPages.set(tabId,page.pageId);await pushSettings(tabId);}
        const audio=await sync.settings();
        if(message.sound&&page.active&&await active()===tabId&&audio.preferences.sound&&audio.soundActivated)await sound();
        return {ok:true};
      }
      if(message.kind==='focus'&&pages.get(tabId)?.groups.some(g=>g.id===message.groupId)){
        selections.set(tabId,message.groupId);if(opening)await opening;void chrome.runtime.sendMessage({kind:'panel/focus',groupId:message.groupId,tabId}).catch(()=>{});return{ok:true};
      }
      throw new Error('Content request rejected');
    }
    if(sender.id!==chrome.runtime.id||!uiUrls.has(sender.url?.split('?')[0]))throw new Error('Request context rejected');
    if(message.ownerId!==undefined&&message.ownerId!==(await sync.state()).ownerId)throw new Error('Account changed');
    if (__GMGN_NARRATIVE_LOCAL__ && message.kind === 'gmgn/narrative') {
      return loadGroupNarrative(await activeUiTab(sender, message.windowId), message.groupId, message.address);
    }
    switch(message.kind){
      case 'x-trending/permission':await refreshXTrendingAccess();return{ok:true};
      case 'state':{
        // Storage and popup navigation stay available while a provider or the API is slow.
        void sync.sync();
        loadAuthOptions();
        const tab=await activeUiTab(sender,message.windowId).catch(()=>undefined),tabId=tab?.id;
        const tabUrl=tab?.url??'';
        const canScanPage=isBscTrenches(tabUrl);
        // The toolbar click already grants temporary activeTab access. Regular
        // state polling does not inject a reader.
        if(tabId!=null){
          const candidate=pages.get(tabId);
          const cached=candidate?.url===tabUrl?candidate:undefined;
          if(message.scanActiveTab===true&&canScanPage&&!live.enabled&&!config.gmgnAuthorized){
            if(cached?.status!=='ready'||Date.now()-cached.updatedAt>manualSnapshotReuseMs){
              // Return a usable cached snapshot immediately. Completion is pushed
              // independently so a refresh cannot blank or block a ready group.
              const scan=scanTrenches(tabId,tabUrl);
              if(cached?.status!=='ready')await scan;
            }
          }else if(!cached){
            if(tab&&live.enabled)void live.recoverTab(tab).catch(()=>{});
            else if(__LOCAL_FIXTURE__||config.gmgnAuthorized)void chrome.tabs.sendMessage(tabId,{kind:'request-page'}).catch(()=>{});
          }
        }
        const [{error:syncError,...state},settings]=await Promise.all([sync.state(),sync.settings()]);
        void refreshTabs().catch(()=>{});
        const cached=tabId==null?undefined:pages.get(tabId);
        const page=cached?.url===tabUrl?cached??null:null;
        const selected=page&&tabId!=null?selections.get(tabId)??null:null;
        const focusRequested=Boolean(page&&sender.url?.split('?')[0]!==sidePanelUrl&&tabId!=null&&focusRequests.delete(tabId));
        const linkError = state.connected && socialError?.ownerId === state.ownerId ? socialError.message : null;
        const narrativeToken = __GMGN_NARRATIVE_LOCAL__ ? gmgnNarrativeAddress(tabUrl) : undefined;
        return{...state,...settings,authOptions,demoAccount:__LOCAL_FIXTURE__,focusRequested,syncError:syncError??linkError??audioError,tabId,
          ...(__GMGN_NARRATIVE_LOCAL__ ? {
            gmgnNarrativeToken: narrativeToken,
            gmgnNarrativePermission: (canScanPage || narrativeToken) && new URL(tabUrl).hostname === 'www.gmgn.ai'
              ? 'https://www.gmgn.ai/*' : undefined,
          } : {}),
          pagePending:tabId!=null&&manualScans.get(tabId)?.url===tabUrl,page,selected,gmgnAuthorized:config.gmgnAuthorized,
          canScanPage,manualPage:Boolean(page&&tabId!=null&&manualPages.has(tabId)),localLiveAvailable:config.localGmgnLive,liveEnabled:live.enabled};
      }
      case 'enable-live':await live.setEnabled(true);for(const tabId of manualPages)forgetPage(tabId);break;
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
