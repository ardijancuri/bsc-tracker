import React,{useEffect,useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {CircleCheck, Copy, ExternalLink, Globe, History, Pencil, Settings, Star, Tag, Trash2, UserRound, WalletCards, X, Zap} from 'lucide-react';
import {defaultExtensionPreferences,extensionAddress,extensionMatchTypes,extensionLabels,extensionTokenImageUrl,type ExtensionAuthOptions,type ExtensionPage,type ExtensionWorkspace,type ExtensionPreferences,type TokenCard,type ExtensionTokenIdentity} from '../../../shared/extension';
import {requestBackground,isExtension,browserApi,config} from './platform';
import {gmgnOrigins} from './liveAccess';
import {cardMetricColor} from './cardMetrics';
import {AccountView,type AccountPending} from './AccountView';
import {WalletsView} from './WalletsView';
import {WalletBuyAmountSettings} from './WalletBuyAmountSettings';
import { XTrendingSettings } from './XTrendingSettings';
import { GroupNarrative } from './GroupNarrative';
import { isBscTrenches } from './adapter';
import {WalletBuyView,loadWalletBuyContext,requestWalletBuyPermission,type WalletBuyContext,type WalletBuyRequest} from './WalletBuyView';
import type {WalletBuyMode} from './walletBuyDefaults';
import {captureWalletBuyTab} from './walletBuyNavigation';
import {walletSelectionKey} from './walletSelection';
import {maxWalletBuyTrades} from './walletSwap';
import type {Draft,PopupUi} from './sync';
import '@fontsource-variable/inter';
import './panel.css';
import './popup.css';
import './matchPause.css';

declare const __GMGN_NARRATIVE_LOCAL__: boolean;

interface State{connected:boolean;workspace:ExtensionWorkspace|null;drafts:Draft[];preferenceDraft?:{conflict?:boolean};preferences:ExtensionPreferences;soundActivated?:boolean;saved:string[];page:ExtensionPage|null;selected:string|null;pending?:AccountPending|null;authOptions?:ExtensionAuthOptions;demoAccount?:boolean;syncError?:string;tabId?:number;pagePending?:boolean;ownerId?:string;ui?:PopupUi;focusRequested?:boolean;canScanPage?:boolean;localLiveAvailable?:boolean;liveEnabled?:boolean;gmgnNarrativeToken?:string;gmgnNarrativePermission?:'https://www.gmgn.ai/*'}
const accountReturnKey='popupAccountReturnUntil';
const empty:State={connected:false,workspace:null,drafts:[],preferences:defaultExtensionPreferences,saved:[],page:null,selected:null};
const short=(address:string)=>`${address.slice(0,6)}…${address.slice(-4)}`;
const destinations = [
  {id:'wallets', label:'Wallets', Icon:WalletCards},
  {id:'tokens', label:'Tokens', Icon:Tag},
  {id:'settings', label:'Settings', Icon:Settings},
  {id:'profile', label:'Profile', Icon:UserRound},
] as const;
type Destination = (typeof destinations)[number]['id'];
const settingsSections = [
  {id:'buy', label:'Buy'},
  {id:'matches', label:'Matches'},
  {id:'alerts', label:'Alerts'},
  {id:'about', label:'About'},
] as const;
type SettingsSection = (typeof settingsSections)[number]['id'];
const availableSettingsSections = settingsSections.filter(section=>isExtension||section.id!=='buy');
const pageAlertLabels = {
  newGroups:'New matching groups',
  newMembers:'New tokens joining a group',
  watchedOnly:'Only groups with saved tokens',
  sound:'Enable alert sound',
} as const;
type SidePanelRoute = {destination:Destination;view:PopupUi['view'];requestedAt:number};
type MatchPause = {groupId:string;page:ExtensionPage;showEnableLive:boolean;refreshFailed:boolean;syncError:string|undefined};
const inSidePanel = isExtension && location.pathname==='/sidepanel.html';
const canOpenSidePanel = isExtension && !inSidePanel && typeof browserApi.sidePanel?.open==='function';
const sidePanelRouteKey = (windowId:number)=>`side-panel-route:${windowId}`;
function emptyMatches(state: State, hasCards: boolean) {
  if (state.page?.status === 'unsupported') return 'Unsupported page layout';
  if (state.page?.status === 'ready') {
    if (!hasCards) return 'Waiting for token cards';
    return state.preferences.matchTypes.length ? 'No shared links on this page' : 'Match types are off';
  }
  if (state.liveEnabled || state.pagePending || state.page?.status==='waiting') return 'Waiting for token cards';
  return 'Could not read BNB Trenches. Reopen Kollens on the tab.';
}
const rowIcons = {edit:Pencil, trash:Trash2, external:ExternalLink, star:Star};
function Icon({name}:{name:keyof typeof rowIcons}) {
  const RowIcon = rowIcons[name];
  return <RowIcon className="ui-icon" size={18} strokeWidth={1.7} aria-hidden="true"/>;
}
function TokenThumbnail({card}:{card:ExtensionTokenIdentity}){
  const [failed,setFailed]=useState<string[]>([]);
  const [loaded,setLoaded]=useState<string|null>(null);
  const observed=extensionTokenImageUrl(card.logoUrl);
  const fallback=extensionAddress(card.address) ? config.apiOrigin+'/api/token-image/'+card.address+'?fallback=extension' : null;
  const src=[observed,fallback].find(url=>url&&!failed.includes(url));
  return <span className="token-monogram token-thumbnail">
    <span aria-hidden="true" style={{visibility:src&&loaded===src?'hidden':'visible'}}>{Array.from(card.symbol||card.name||'?')[0]}</span>
    {src&&<img key={src} src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
      onLoad={()=>setLoaded(src)} onError={()=>setFailed(previous=>[...previous.slice(-5),src])}/>}
  </span>;
}
function TokenRow({card,metrics,favorite,actions,onCopyError,onBuy,buyAmount,buyReady}:{card:ExtensionTokenIdentity;metrics?:Pick<TokenCard,'marketCap'|'volume'>;favorite?:React.ReactNode;actions?:React.ReactNode;onCopyError:()=>void;onBuy?:()=>void;buyAmount?:string;buyReady:boolean}){
  const hasDistinctName = card.name && card.symbol && card.name.trim().toLowerCase() !== card.symbol.trim().toLowerCase();
  const marketCap = metrics?.marketCap?.value;
  const volume = metrics?.volume?.value;
  const marketMetrics = <span className="token-metrics">
    <span className="token-metric" title={marketCap ? 'Market cap: '+marketCap : 'Market cap'}>
      <span>MC</span><span style={{color:cardMetricColor(metrics?.marketCap)}}>{marketCap??'—'}</span>
    </span>
    <span className="token-metric" title={volume ? 'Volume: '+volume : 'Volume'}>
      <span>V</span><span style={{color:cardMetricColor(metrics?.volume)}}>{volume??'—'}</span>
    </span>
  </span>;
  return <div className="token-row">
    <TokenThumbnail key={card.address} card={card}/>
    <div className="token-identity">
      <strong>{card.symbol || card.name || short(card.address)}</strong>
      {hasDistinctName && <span>{card.name}</span>}
      <button className="address" title="Copy contract address" onClick={()=>void navigator.clipboard.writeText(card.address).catch(onCopyError)}>
        {short(card.address)}<Copy className="ui-icon" size={11} strokeWidth={1.25} aria-hidden="true"/>
      </button>
    </div>
    <div className="token-quick-actions">
      {favorite}
      <a className="gmgn-link" href={`https://gmgn.ai/bsc/token/${card.address}`} target="_blank" rel="noopener noreferrer" title="Open token on GMGN" aria-label="Open token on GMGN">
        <img src="assets/gmgn.png" alt=""/>
      </a>
    </div>
    {!onBuy&&marketMetrics}
    {actions&&<div className="token-actions">{actions}</div>}
    {onBuy&&<button type="button" className="token-buy token-buy-area" aria-label={`Buy ${card.symbol||card.name||short(card.address)}`}
        title={buyAmount ? `Buy ${buyAmount} BNB per selected wallet` : 'Set a single-token amount in Settings → Buy'}
        aria-description={[marketCap && 'Market cap '+marketCap,volume && 'Volume '+volume].filter(Boolean).join(', ')||undefined}
        disabled={!buyReady} onClick={onBuy}>
      {marketMetrics}
      <span className="token-buy-label"><Zap size={12} fill="currentColor" aria-hidden="true"/>Buy</span>
    </button>}
  </div>;
}
function Panel(){
  const[state,setState]=useState(empty),[view,setView]=useState<PopupUi['view']>('matches'),[destination,setDestination]=useState<Destination>(isExtension?'wallets':'tokens'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [checkingTab, setCheckingTab] = useState(isExtension);
  const [walletCopy, setWalletCopy] = useState<{success:boolean}|null>(null);
  const [buyView, setBuyView] = useState<WalletBuyRequest|'activity'|null>(null);
  const [buyContext, setBuyContext] = useState<WalletBuyContext|null>(null);
  const [matchPause, setMatchPause] = useState<MatchPause|null>(null);
  const groupBuyAmount = buyContext?.settings.amounts.group;
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(isExtension?'buy':'matches');
  const [windowId, setWindowId] = useState<number>();
  const ownWindowId = useRef<number|undefined>(undefined);
  const mainRef=useRef<HTMLElement>(null);
  const selectedGroupRef=useRef<HTMLElement>(null);
  const chosenDestination=useRef(false),firstState=useRef(true);
  const scanActiveTab=useRef(isExtension);
  const tabEpoch=useRef(0);
  const displayedTab=useRef<number|undefined>(undefined);
  const refreshQueued=useRef(false);
  const[note,setNote]=useState<PopupUi['editor']>(null),inFlight=useRef(false),mutationEpoch=useRef(0),uiOwner=useRef<string|undefined>(undefined),chosenView=useRef<PopupUi['view']|null>(null);
  const clearAccountReturn=()=>{if(isExtension)void browserApi.storage.session.remove(accountReturnKey).catch(()=>{});};
  const selectSettingsSection = (section: SettingsSection) => {
    setSettingsSection(section);
    mainRef.current?.scrollTo(0, 0);
  };
  const handleSettingsTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = availableSettingsSections.length;
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowLeft': nextIndex = (index + count - 1) % count; break;
      case 'ArrowRight': nextIndex = (index + 1) % count; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = count - 1; break;
      default: return;
    }
    event.preventDefault();
    const section = availableSettingsSections[nextIndex].id;
    selectSettingsSection(section);
    document.getElementById(`settings-tab-${section}`)?.focus();
  };
  const navigate=(next:Destination)=>{
    chosenDestination.current=true;
    if(next!=='tokens')setBuyView(null);
    if(next!=='profile')clearAccountReturn();
    setDestination(next);
    if(isExtension&&next==='tokens'&&destination!=='tokens'){
      scanActiveTab.current=true;
      void refresh();
    }
  };
  useEffect(()=>{
    if (!isExtension || destination!=='tokens') return;
    let revision = 0;
    const load = () => {
      const expected = ++revision;
      setBuyContext(null);
      void loadWalletBuyContext().then(context=>{
        if (expected===revision) setBuyContext(context);
      }).catch(()=>{
        if (expected===revision) setError('Could not load buy settings or wallets. Reopen Tokens to try again.');
      });
    };
    const changed = (changes:Record<string,chrome.storage.StorageChange>,area:string) => {
      if (area==='local' && (changes[walletSelectionKey] || Object.keys(changes).some(key=>key.startsWith('wallet-buy-')))) load();
    };
    browserApi.storage.onChanged.addListener(changed);
    load();
    return ()=>{
      revision++;
      browserApi.storage.onChanged.removeListener(changed);
    };
  },[destination]);

  const startBuy = (tokens:ExtensionTokenIdentity[],mode:WalletBuyMode) => {
    if (buyView || !buyContext) return;
    const {wallets,settings} = buyContext;
    if (!wallets.length) {
      setError('Select one or more wallets in Wallets to buy.');
      return;
    }
    if (!settings.amounts[mode]) {
      setError(`Set a ${mode==='group'?'group-buy':'single-token'} amount in Settings → Buy.`);
      return;
    }
    if (wallets.length*tokens.length>maxWalletBuyTrades) {
      setError(`Buy up to ${maxWalletBuyTrades} orders at once. Select fewer wallets or buy tokens individually.`);
      return;
    }
    setError('');
    const originTab = mode==='single' ? captureWalletBuyTab(browserApi.tabs, ownWindowId.current) : undefined;
    // Chrome needs the click gesture if RPC access has yet to be granted.
    const permission = wallets.every(wallet=>wallet.protection==='device') ? requestWalletBuyPermission() : undefined;
    setBuyView({...buyContext,tokens,mode,permission,originTab});
  };
  const remember=(patch:Partial<PopupUi>,ownerId=uiOwner.current)=>{if(ownerId)void requestBackground({kind:'ui',ownerId,patch}).catch(()=>setError('Could not keep this draft locally. Save it before closing.'));};
  const changeView=(next:PopupUi['view'])=>{chosenView.current=next;setView(next);navigate('tokens');remember({view:next});};
  const changeNote=(editor:PopupUi['editor'])=>{setNote(editor);remember({editor});};
  const refresh = async () => {
    if (inFlight.current) {
      // The next snapshot can arrive while the previous request is awaiting
      // storage. Coalesce it, but don't leave it waiting on the polling timer.
      refreshQueued.current = true;
      return;
    }
    inFlight.current = true;
    const epoch = mutationEpoch.current;
    const activeTabEpoch = tabEpoch.current;
    const isCurrent = () => epoch === mutationEpoch.current && activeTabEpoch === tabEpoch.current;
    const scan = scanActiveTab.current;
    scanActiveTab.current = false;
    try {
      const result = await requestBackground<State>({kind:'state',scanActiveTab:scan,windowId:ownWindowId.current});
      if (!isCurrent()) return;
      if (firstState.current) {
        const stored=await (isExtension?browserApi.storage.session.get(accountReturnKey).catch(()=>null):null);
        if (!isCurrent()) return;
        firstState.current=false;
        const returning=Number(stored?.[accountReturnKey])>Date.now();
        if (!chosenDestination.current && (returning || result.pending?.method==='email' || result.pending?.method==='google')) {
          setDestination('profile');
        }
        if (returning && result.connected && !inSidePanel) clearAccountReturn();
      }
      if (result.ownerId !== uiOwner.current) {
        const nextView = chosenView.current ?? result.ui?.view ?? 'matches';
        uiOwner.current = result.ownerId;
        setView(nextView);
        setNote(result.ui?.editor ?? null);
        if (chosenView.current) remember({view:nextView}, result.ownerId);
      }
      if (result.focusRequested) {
        setView('matches');
        setDestination('tokens');
        remember({view:'matches'}, result.ownerId);
      }
      displayedTab.current=result.tabId;
      setState(result);
      setCheckingTab(false);
      setRefreshFailed(false);
    } catch {
      if (isCurrent()) {
        setCheckingTab(false);
        setRefreshFailed(true);
      }
    } finally {
      inFlight.current = false;
      if (refreshQueued.current || scanActiveTab.current) {
        refreshQueued.current = false;
        void refresh();
      }
    }
  };
  useEffect(()=>{
    let active = true;
    let timer:ReturnType<typeof setInterval>|undefined;
    const poll=()=>{
      if (!active) return;
      void refresh();
      timer=setInterval(()=>void refresh(),2000);
    };
    if (canOpenSidePanel||inSidePanel) {
      const resolveWindow=async()=>{
        const window=await browserApi.windows.getCurrent().catch(()=>undefined);
        if (window?.id!==undefined&&window.id>=0) return window.id;
        return (await browserApi.tabs.query({active:true,currentWindow:true}))[0]?.windowId;
      };
      void resolveWindow().then(id=>{
        if (active&&id!==undefined&&id>=0) {
          ownWindowId.current=id;
          setWindowId(id);
        }
      }).catch(()=>{}).finally(poll);
    } else {
      poll();
    }
    return ()=>{active=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{
    if (!inSidePanel||windowId===undefined) return;
    const key = sidePanelRouteKey(windowId);
    let active = true;
    let lastRequest = 0;
    const applyRoute = (route:Partial<SidePanelRoute>|undefined) => {
      if (!active||typeof route?.requestedAt!=='number'||route.requestedAt<=lastRequest||
        Date.now()-route.requestedAt>15_000) return;
      const next=destinations.find(item=>item.id===route.destination)?.id;
      if (!next) return;
      lastRequest=route.requestedAt;
      chosenDestination.current=true;
      if (next!=='tokens') setBuyView(null);
      setDestination(next);
      if (route.view==='matches'||route.view==='saved'||route.view==='activity') {
        chosenView.current=route.view;
        setView(route.view);
      }
      if (next==='tokens') {
        scanActiveTab.current=true;
        void refresh();
      }
    };
    const changed = (changes:Record<string,chrome.storage.StorageChange>,area:string) => {
      if (area==='session'&&changes[key]) applyRoute(changes[key].newValue as Partial<SidePanelRoute>|undefined);
    };
    browserApi.storage.onChanged.addListener(changed);
    void browserApi.storage.session.get(key).then(result=>applyRoute(result[key] as Partial<SidePanelRoute>|undefined)).catch(()=>{});
    return ()=>{
      active=false;
      browserApi.storage.onChanged.removeListener(changed);
    };
  },[windowId]);
  useEffect(()=>{
    if (!inSidePanel||windowId===undefined) return;
    const switchTab=()=>{
      tabEpoch.current++;
      displayedTab.current=undefined;
      setCheckingTab(true);
      scanActiveTab.current=true;
      setState(current=>({...current,page:null,selected:null,canScanPage:false,
        ...(__GMGN_NARRATIVE_LOCAL__ ? {gmgnNarrativeToken:undefined,gmgnNarrativePermission:undefined} : {})}));
      void refresh();
    };
    const activated=(tab:chrome.tabs.OnActivatedInfo)=>{
      if (tab.windowId===windowId) switchTab();
    };
    const updated=(_id:number,change:chrome.tabs.OnUpdatedInfo,tab:chrome.tabs.Tab)=>{
      if (!tab.active||tab.windowId!==windowId) return;
      if (change.status==='loading'||change.url!==undefined) switchTab();
      else if (change.status==='complete') {
        scanActiveTab.current=true;
        void refresh();
      }
    };
    browserApi.tabs.onActivated.addListener(activated);
    browserApi.tabs.onUpdated.addListener(updated);
    return ()=>{
      browserApi.tabs.onActivated.removeListener(activated);
      browserApi.tabs.onUpdated.removeListener(updated);
    };
  },[windowId]);
  useEffect(()=>{mainRef.current?.scrollTo(0,0);},[destination,view]);
  useEffect(()=>{
    if (!walletCopy) return;
    const timeout = window.setTimeout(()=>setWalletCopy(null),3000);
    return ()=>window.clearTimeout(timeout);
  },[walletCopy]);
  useEffect(()=>{
    const page=(event:Event)=>setState(current=>({...current,page:(event as CustomEvent).detail}));
    const focus=(event:Event)=>{setState(current=>({...current,selected:(event as CustomEvent).detail}));changeView('matches');};
    const update=(message:any,sender:any)=>{
      if(sender.id!==browserApi.runtime.id||sender.tab)return;
      if(message?.tabId!==undefined&&displayedTab.current!==undefined&&message.tabId!==displayedTab.current)return;
      if(message?.kind==='panel/changed')void refresh();
      if(message?.kind==='panel/focus'){
        setState(current=>({...current,selected:message.groupId}));
        changeView('matches');
        void refresh();
      }
    };
    if(isExtension)browserApi.runtime.onMessage.addListener(update);
    else{window.addEventListener('kollens:live-page',page);window.addEventListener('kollens:live-focus',focus);}
    return()=>{if(isExtension)browserApi.runtime.onMessage.removeListener(update);else{window.removeEventListener('kollens:live-page',page);window.removeEventListener('kollens:live-focus',focus);}};
  },[]);
  const action=async(message:Record<string,unknown>)=>{
    const epoch=++mutationEpoch.current;
    setBusy(true);
    setError('');
    try {
      await requestBackground({...message,ownerId:uiOwner.current,windowId:ownWindowId.current});
      if (epoch!==mutationEpoch.current) return false;
      await refresh();
      return true;
    } catch(e) {
      if (epoch===mutationEpoch.current) setError(e instanceof Error?e.message:'Request failed');
      return false;
    } finally {
      if (epoch===mutationEpoch.current) setBusy(false);
    }
  };
  const accountAction=async(message:Record<string,unknown>)=>{
    if (isExtension && (message.kind==='google-connect' || message.kind==='link-social')) {
      // The toolbar popup can close while Chrome's authorization window has focus.
      void browserApi.storage.session.set({[accountReturnKey]:Date.now()+10*60_000}).catch(()=>{});
    }
    const success=await action(message);
    if (success && (message.kind==='cancel-pairing' || message.kind==='disconnect')) clearAccountReturn();
    return success;
  };
  const enableLive=async()=>{
    // Must be invoked directly from the click, before any asynchronous work.
    try{const granted=await browserApi.permissions.request({origins:gmgnOrigins});if(!granted){setError('GMGN site access was not granted.');return;}changeView('matches');await action({kind:'enable-live'});}
    catch{setError('Could not enable GMGN. Reload the extension and try again.');}
  };
  const activeMatchPause = matchPause && destination==='tokens' && view==='matches' && !buyView &&
    state.page?.status==='ready' && state.page.pageId===matchPause.page.pageId && state.page.url===matchPause.page.url
    ? matchPause : null;
  // Hold the entire layout so changes to a group above the pointer cannot move the intended Buy button.
  const matchesPage = activeMatchPause?.page ?? state.page;
  const showNarrative = __GMGN_NARRATIVE_LOCAL__ && isExtension && isBscTrenches(matchesPage?.url ?? '');
  const narrativeToken = __GMGN_NARRATIVE_LOCAL__ && isExtension && extensionAddress(state.gmgnNarrativeToken)
    ? state.gmgnNarrativeToken : null;
  const cards=matchesPage?.cards??[],groups=matchesPage?.groups??[],unique=new Map<string,TokenCard>();
  useEffect(()=>{
    if (matchPause && !activeMatchPause) setMatchPause(null);
  },[matchPause,activeMatchPause]);
  const liveAccessPrompt = Boolean(state.canScanPage && state.localLiveAvailable && !state.liveEnabled);
  const visibleRefreshFailed = activeMatchPause?.refreshFailed ?? refreshFailed;
  const visibleSyncError = activeMatchPause ? activeMatchPause.syncError : state.syncError;
  const pauseMatch = (event:React.PointerEvent,groupId:string) => {
    if (event.pointerType==='mouse' && matchesPage?.status==='ready') {
      setMatchPause({groupId,page:matchesPage,showEnableLive:activeMatchPause?.showEnableLive ?? liveAccessPrompt,
        refreshFailed:visibleRefreshFailed,syncError:visibleSyncError});
    }
  };
  const resumeMatch = (groupId:string) => {
    setMatchPause(current=>current?.groupId===groupId ? null : current);
  };
  for (const card of cards) {
    const otherCard = unique.get(card.address);
    unique.set(card.address, {
      ...card,
      logoUrl: card.logoUrl ?? otherCard?.logoUrl ?? null,
      marketCap: card.marketCap ?? otherCard?.marketCap,
      volume: card.volume ?? otherCard?.volume,
    });
  }
  const choose=(groupId:string)=>{
    if (!groups.some(group=>group.id===groupId)) return;
    changeView('matches');
    setState(current=>({...current,selected:groupId}));
    void action({kind:'select',groupId});
  };
  useEffect(()=>{
    if(view==='matches'&&destination==='tokens'&&!activeMatchPause)selectedGroupRef.current?.scrollIntoView({block:'nearest'});
  },[view,destination,state.selected]);
  const preferences=(patch:Partial<ExtensionPreferences>)=>{const next={...state.preferences,...patch};setState(current=>({...current,preferences:next,...('sound'in patch?{soundActivated:patch.sound}:{})}));void action({kind:'preferences',preferences:next,activateSound:patch.sound===true});};
  const shownItems=new Map(state.workspace?.items.map(item=>[item.address,{...item,local:false}])??[]);
  for(const draft of state.drafts)if(draft.item)shownItems.set(draft.address,{...draft.item,revision:draft.revision,updatedAt:'',local:true});
  const draftsByAddress = new Map(state.drafts.map(draft => [draft.address, draft]));
  const savedItems = [...shownItems.values()].filter(item => {
    const draft = draftsByAddress.get(item.address);
    // Keep failed or conflicting edits visible for review.
    return item.pinned || draft?.conflict || draft?.error;
  });
  const toggleFavorite=(card:ExtensionTokenIdentity)=>{
    if(!state.connected){
      setError('Connect your Kollens account to favorite tokens.');
      return;
    }
    const saved=shownItems.get(card.address);
    void action({kind:'edit',field:'pinned',item:{
      chainId:56,address:card.address,name:saved?.name??card.name,symbol:saved?.symbol??card.symbol,
      logoUrl:saved?.logoUrl??card.logoUrl??null,pinned:!saved?.pinned,note:saved?.note??'',
    }});
  };
  const showTrenchesLink = !checkingTab && !state.canScanPage && (!state.page || state.page.status === 'disabled');
  const canEnableLive = activeMatchPause?.showEnableLive ?? liveAccessPrompt;
  const copyError=()=>setError('Copy failed');
  const copyWalletAddress=async(address:string)=>{
    try {
      await navigator.clipboard.writeText(address);
      setWalletCopy({success:true});
    } catch {
      setWalletCopy({success:false});
    }
  };
  const demoConnect = state.demoAccount && !state.authOptions?.google && !state.authOptions?.email;
  const openSidePanel = () => {
    if (windowId===undefined) return;
    const route:SidePanelRoute={destination,view,requestedAt:Date.now()};
    void browserApi.storage.session.set({[sidePanelRouteKey(windowId)]:route}).catch(()=>{});
    // Call directly from the click so Chrome sees the user gesture.
    void browserApi.sidePanel.open({windowId}).then(()=>{
      if (location.pathname==='/popup.html') window.close();
    }).catch(()=>setError('Could not open the side panel. Try again.'));
  };
  const connect = <button className="popup-action" disabled={busy || Boolean(demoConnect && state.pending)}
    onClick={()=>demoConnect ? void action({kind:'connect'}) : navigate('profile')}>
    {demoConnect ? 'Connect Kollens' : 'Sign in'}
  </button>;
  return <div className="workspace">
    <header className="popup-header">
      <img className="brand-mark" src="assets/icon.png" alt="Kollens"/>
      <h1>{destination==='profile' ? 'Account' : destinations.find(item=>item.id===destination)?.label}</h1>
      {(destination==='wallets'||destination==='tokens'&&isExtension||canOpenSidePanel)&&<div className="header-actions">
        {destination==='wallets'&&<span className="network-pill"><img src="assets/bnb-chain.svg" alt=""/>BNB</span>}
        {destination==='tokens'&&isExtension&&buyView===null&&
          <button type="button" className="side-panel-button" aria-label="Buy activity" title="Buy activity" onClick={()=>setBuyView('activity')}>
            <History size={15} strokeWidth={1.5} aria-hidden="true"/>
          </button>}
        {canOpenSidePanel&&buyView===null&&<button type="button" className="side-panel-button" aria-label="Open side panel" title="Open side panel"
          disabled={windowId===undefined} onClick={openSidePanel}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden="true">
            <rect x=".5" y=".5" width="13" height="13" rx="2"/>
            <path d="M9.5 1v12"/>
          </svg>
        </button>}
      </div>}
    </header>
    {destination==='wallets'&&walletCopy&&<div className={`feedback wallet-copy-feedback${walletCopy.success?' success':''}`}>
      <span className="wallet-copy-status" role="status">
        {walletCopy.success&&<CircleCheck size={15} aria-hidden="true"/>}
        {walletCopy.success?'Address copied.':'Could not copy address.'}
      </span>
      <button type="button" aria-label="Dismiss copy message" onClick={()=>setWalletCopy(null)}><X size={14} aria-hidden="true"/></button>
    </div>}
    {destination==='tokens'&&buyView===null&&<nav className="workspace-tabs" aria-label="Workspace views">{(['matches','saved','activity']as const).map(tab=><button key={tab} className={view===tab?'active':''} aria-current={view===tab?'page':undefined} onClick={()=>changeView(tab)}>{tab[0].toUpperCase()+tab.slice(1)}<span>{tab==='matches'?groups.length:tab==='saved'?savedItems.length:state.page?.alerts.length??0}</span></button>)}</nav>}
    {error&&<div role="alert" className="feedback">{error}<button aria-label="Dismiss error" onClick={()=>setError('')}>×</button></div>}
    {destination!=='wallets'&&visibleRefreshFailed&&<div className="feedback refresh-feedback" role="status">
      <span>Connection interrupted. Retrying…</span>
      <button onClick={()=>void refresh()}>Retry now</button>
    </div>}
    {destination!=='wallets'&&visibleSyncError&&<p className="feedback" role="status">{visibleSyncError}</p>}
    {destination==='settings'&&<nav className="workspace-tabs" role="tablist" aria-label="Settings categories">
      {availableSettingsSections.map(({id,label}, index)=><button key={id} type="button" role="tab"
        id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`} aria-selected={settingsSection===id}
        tabIndex={settingsSection===id?0:-1} onClick={()=>selectSettingsSection(id)}
        onKeyDown={event=>handleSettingsTabKey(event,index)}>{label}</button>)}
    </nav>}
    <main ref={mainRef} className={`popup-main ${destination}-view`}>
    {destination==='wallets'&&<WalletsView onCopyAddress={copyWalletAddress}/>}
    {destination==='profile'&&<AccountView user={state.connected ? state.workspace?.user : undefined}
      options={state.authOptions} pending={state.pending} demo={state.demoAccount===true} busy={busy}
      action={accountAction} onCopyError={copyError}/>}
    {destination==='settings'&&<section className="settings">
      {state.preferenceDraft?.conflict&&<div className="conflict settings-conflict">
        <div role="status">Match or alert settings changed on another browser.</div>
        <button type="button" onClick={()=>void action({kind:'resolvePreferences',choice:'server'})}>Use synced settings</button>
        <button type="button" onClick={()=>void action({kind:'resolvePreferences',choice:'mine'})}>Keep my settings</button>
      </div>}
      {isExtension&&<div role="tabpanel" id="settings-panel-buy" aria-labelledby="settings-tab-buy" hidden={settingsSection!=='buy'}>
        <WalletBuyAmountSettings/>
      </div>}
      <div role="tabpanel" id="settings-panel-matches" aria-labelledby="settings-tab-matches" hidden={settingsSection!=='matches'}>
        <section className="settings-group">
          <h2>Match settings</h2>
          <label>
            <input type="checkbox" checked={state.preferences.highlights}
              onChange={event=>preferences({highlights:event.target.checked})}/>
            Highlight matching cards
          </label>
          {extensionMatchTypes.map(type=><label key={type}>
            <input type="checkbox" checked={state.preferences.matchTypes.includes(type)}
              onChange={event=>preferences({matchTypes:event.target.checked
                ?[...state.preferences.matchTypes,type]
                :state.preferences.matchTypes.filter(selected=>selected!==type)})}/>
            {extensionLabels[type]}
          </label>)}
        </section>
      </div>
      <div role="tabpanel" id="settings-panel-alerts" aria-labelledby="settings-tab-alerts" hidden={settingsSection!=='alerts'}>
        <section className="settings-group">
          <h2>Page alerts</h2>
          {(Object.keys(pageAlertLabels) as (keyof typeof pageAlertLabels)[]).map(key=><label key={key}>
            <input type="checkbox" checked={state.preferences[key]&&(key!=='sound'||Boolean(state.soundActivated))}
              onChange={event=>preferences({[key]:event.target.checked})}/>
            {pageAlertLabels[key]}
          </label>)}
        </section>
      </div>
      <div role="tabpanel" id="settings-panel-about" aria-labelledby="settings-tab-about" hidden={settingsSection!=='about'}>
        {isExtension&&<XTrendingSettings/>}
        <section className="settings-group settings-links">
          <h2>Kollens links</h2>
          <a href="https://kollens.com/" target="_blank" rel="noopener noreferrer">
            <Globe size={14} aria-hidden="true"/>
            kollens.com
          </a>
          <a href="https://x.com/kollens" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.829L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.491h2.039L6.486 3.24H4.299l13.312 17.404Z"/>
            </svg>
            @kollens on X
          </a>
        </section>
      </div>
    </section>}
    {destination==='tokens'&&buyView!==null&&
      <WalletBuyView request={buyView==='activity'?null:buyView} onClose={()=>setBuyView(null)}/>}
    {destination==='tokens'&&buyView===null&&<>
      {view==='matches'&&<div className="match-stack" key={matchesPage?.pageId}>
        {canEnableLive&&<div className="empty"><button className="scan-button" disabled={busy} onClick={()=>void enableLive()}>Enable on GMGN</button></div>}
        {groups.length?groups.map(group=><section ref={state.selected===group.id?selectedGroupRef:undefined} className={`group ${state.selected===group.id?'selected':''}`} key={group.id} style={{'--group-color':group.color}as React.CSSProperties}
          data-paused={activeMatchPause?.groupId===group.id} onPointerEnter={event=>pauseMatch(event,group.id)} onPointerLeave={()=>resumeMatch(group.id)} onPointerCancel={()=>resumeMatch(group.id)}>
          <div className="group-header">
            <button className="group-heading" onClick={()=>choose(group.id)}>
              <span className="group-marker"/><strong>{extensionLabels[group.type]}</strong>
              <span className="match-group-status">
                <span className="match-group-count">{group.addresses.length} tokens</span>
                <span className="match-group-paused" title="Live updates paused while hovering">Paused</span>
              </span>
            </button>
            <div className="group-actions">
              {__GMGN_NARRATIVE_LOCAL__&&showNarrative&&group.type!=='telegram'&&unique.has(group.addresses[0])&&
                <GroupNarrative key={group.addresses[0]} groupId={group.id} address={group.addresses[0]} origin={state.gmgnNarrativePermission} windowId={windowId}/>}
              <a className="source-link" href={group.url} target="_blank" rel="noopener noreferrer" title="Open source link" aria-label={`Open source link for ${extensionLabels[group.type]}`}><Icon name="external"/></a>
              {isExtension&&group.addresses.every(address=>unique.has(address))&&
                <button type="button" className="token-buy" disabled={!buyContext} title={groupBuyAmount
                  ? `Buy ${groupBuyAmount} BNB per token, per selected wallet` : 'Set a group-buy amount in Settings → Buy'}
                  onClick={()=>startBuy(group.addresses.map(address=>unique.get(address)!),'group')}><Zap size={12} fill="currentColor" aria-hidden="true"/>Buy all</button>}
            </div>
          </div>
          <div className="token-stack">
            {group.addresses.map(address=>{
              const card = unique.get(address);
              if (!card) return null;
              const favorite = shownItems.get(address)?.pinned ?? false;
              return <TokenRow key={address} card={card} metrics={card} onCopyError={copyError}
                buyReady={!!buyContext} buyAmount={buyContext?.settings.amounts.single} onBuy={isExtension?()=>startBuy([card],'single'):undefined} favorite={
                <button type="button" title={favorite?'Unfavorite token':'Favorite token'}
                  aria-label={`Favorite ${card.symbol||card.name||short(address)}`} aria-pressed={favorite}
                  className={favorite?'token-save is-saved':'token-save'} disabled={busy} onClick={()=>toggleFavorite(card)}>
                  <Icon name="star"/>
                </button>
              }/>;
            })}
          </div>
        </section>):__GMGN_NARRATIVE_LOCAL__&&narrativeToken?<div className="group-header standalone-narrative" key={narrativeToken}>
          <span>Current token · {short(narrativeToken)}</span>
          <GroupNarrative address={narrativeToken} origin={state.gmgnNarrativePermission} windowId={windowId}/>
        </div>:showTrenchesLink?<a className="trenches-empty" href="https://gmgn.ai/?chain=bsc" target="_blank" rel="noopener noreferrer">
          <img src="assets/gmgn.png" alt=""/>
          <span>Open GMGN BNB trenches to find matches</span>
        </a>:canEnableLive&&!state.page?null:<div className="empty"><h2>{checkingTab?'Loading token matches…':emptyMatches(state,unique.size>0)}</h2></div>}
      </div>}
      {view==='saved'&&<>
        {!state.connected&&<div className="empty"><h2>Connect to save tokens</h2>{connect}</div>}
        {savedItems.length>0&&<div className="saved-stack token-stack">
          {savedItems.map(item=>{
            const draft = draftsByAddress.get(item.address);
            const card = {...item,logoUrl:unique.get(item.address)?.logoUrl??item.logoUrl};
            const syncStatus = draft?.conflict?'Note needs review':draft?.error??(item.local?'Not synced':null);
            return <section className="saved-item" key={item.address}>
              <TokenRow card={card} metrics={unique.get(item.address)} onCopyError={copyError}
                buyReady={!!buyContext} buyAmount={buyContext?.settings.amounts.single} onBuy={isExtension?()=>startBuy([card],'single'):undefined} actions={<>
                <button title="Edit note" aria-label="Edit note" onClick={()=>changeNote({identity:{chainId:56,address:item.address,name:item.name,symbol:item.symbol,logoUrl:card.logoUrl},text:draft?.item?.note??item.note,dirty:false})}><Icon name="edit"/></button>
                <button title="Remove token" aria-label="Remove token" onClick={()=>void action({kind:'edit',action:'delete',item})}><Icon name="trash"/></button>
              </>}/>
              {syncStatus&&<p className="saved-status">{syncStatus}</p>}
              {item.note&&<p className="note-preview">{item.note}</p>}
              {draft?.conflict&&<div className="conflict">
                <p>This note changed on another browser.</p>
                <button onClick={()=>void action({kind:'resolve',address:item.address,choice:'server'})}>Use synced version</button>
                <button onClick={()=>void action({kind:'resolve',address:item.address,choice:'mine'})}>Keep my draft</button>
              </div>}
            </section>;
          })}
        </div>}
        {state.connected&&!savedItems.length&&<div className="empty"><h2>No saved tokens</h2></div>}
      </>}
      {view==='activity'&&<>{state.page?.alerts.length?state.page.alerts.map(alert=>{
        const present=groups.some(group=>group.id===alert.groupId);
        const details = <>
          <span className={`dot ${present?'live':''}`} aria-hidden="true"/>
          <div><strong>{alert.type==='new_group'?'New matching group':'New token joined'}</strong>
            <p>{extensionLabels[alert.matchType]} · {present?`${alert.addresses.length} tokens`:'Group unavailable'}</p>
          </div>
          <time>{new Date(alert.occurredAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>
        </>;
        return present?<button key={alert.id} className="activity-row" onClick={()=>choose(alert.groupId)}>{details}</button>:<div key={alert.id} className="activity-row">{details}</div>;
      }):<div className="empty"><h2>No changes yet</h2></div>}</>}
    </>}
    </main>
    <nav className="bottom-nav" aria-label="Extension navigation">
      {destinations.map(({id,label,Icon:DestinationIcon})=><button key={id} aria-label={label} title={label}
        className="destination-button" aria-current={destination===id?'page':undefined} onClick={()=>navigate(id)}>
        <DestinationIcon size={21} strokeWidth={1.55} aria-hidden="true"/>
        {id==='profile'&&state.connected&&<span className="account-status" aria-hidden="true"/>}
      </button>)}
    </nav>
    {destination==='tokens'&&note&&<div className="note-editor" role="dialog" aria-label="Private token note"><div><h2>{note.identity.symbol||note.identity.name}</h2><span>Private note</span></div><textarea autoFocus maxLength={2000} value={note.text} onChange={e=>changeNote({...note,text:e.target.value,dirty:true})}/><small>{note.text.length}/2000</small><div><button onClick={()=>{if(!note.dirty||confirm('Discard this unsaved note draft?'))changeNote(null);}}>Cancel</button><button className="primary" disabled={busy} onClick={()=>{void action({kind:'edit',field:'note',item:{
      ...note.identity,pinned:shownItems.get(note.identity.address)?.pinned??true,note:note.text,
    }}).then(success=>{if(success)changeNote(null);});}}>Save note</button></div></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Panel/>);
