import React,{useEffect,useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Copy, ExternalLink, Pencil, Settings, Star, Tag, Trash2, UserRound, WalletCards} from 'lucide-react';
import {defaultExtensionPreferences,extensionMatchTypes,extensionLabels,extensionTokenImageUrl,type ExtensionAuthOptions,type ExtensionPage,type ExtensionWorkspace,type ExtensionPreferences,type TokenCard,type ExtensionTokenIdentity} from '../../../shared/extension';
import {requestBackground,isExtension,browserApi} from './platform';
import {gmgnOrigins} from './liveAccess';
import {cardMetricColor} from './cardMetrics';
import {AccountView,type AccountPending} from './AccountView';
import {WalletsView} from './WalletsView';
import type {Draft,PopupUi} from './sync';
import '@fontsource-variable/inter';
import './panel.css';
import './popup.css';

interface State{connected:boolean;workspace:ExtensionWorkspace|null;drafts:Draft[];preferenceDraft?:{conflict?:boolean};preferences:ExtensionPreferences;soundActivated?:boolean;saved:string[];page:ExtensionPage|null;selected:string|null;pending?:AccountPending|null;authOptions?:ExtensionAuthOptions;demoAccount?:boolean;error?:string;gmgnAuthorized:boolean;ownerId?:string;ui?:PopupUi;focusRequested?:boolean;canScanPage?:boolean;localLiveAvailable?:boolean;liveEnabled?:boolean}
const accountReturnKey='popupAccountReturnUntil';
const empty:State={connected:false,workspace:null,drafts:[],preferences:defaultExtensionPreferences,saved:[],page:null,selected:null,gmgnAuthorized:false};
const short=(address:string)=>`${address.slice(0,6)}…${address.slice(-4)}`;
const destinations = [
  {id:'wallets', label:'Wallets', Icon:WalletCards},
  {id:'tokens', label:'Tokens', Icon:Tag},
  {id:'settings', label:'Settings', Icon:Settings},
  {id:'profile', label:'Profile', Icon:UserRound},
] as const;
type Destination = (typeof destinations)[number]['id'];
function emptyMatches(state: State, hasCards: boolean) {
  if (state.page?.status === 'unsupported') return 'Unsupported page layout';
  if (state.page?.status === 'ready') {
    if (!hasCards) return 'Waiting for token cards';
    return state.preferences.matchTypes.length ? 'No shared links on this page' : 'Match types are off';
  }
  if (state.localLiveAvailable) return 'Waiting for token cards';
  return 'Scan this tab to find matches';
}
const rowIcons = {edit:Pencil, trash:Trash2, copy:Copy, external:ExternalLink, star:Star};
function Icon({name}:{name:keyof typeof rowIcons}) {
  const RowIcon = rowIcons[name];
  return <RowIcon className="ui-icon" size={18} strokeWidth={1.7} aria-hidden="true"/>;
}
function TokenThumbnail({card}:{card:ExtensionTokenIdentity}){
  const [failed,setFailed]=useState<string|null>(null),[loaded,setLoaded]=useState<string|null>(null),src=extensionTokenImageUrl(card.logoUrl),show=Boolean(src&&failed!==src);
  return <span className="token-monogram token-thumbnail"><span aria-hidden="true" style={{visibility:show&&loaded===src?'hidden':'visible'}}>{Array.from(card.symbol||card.name||'?')[0]}</span>{show&&<img src={src!} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={()=>setLoaded(src)} onError={()=>setFailed(src)}/>}</span>;
}
function TokenRow({card,metrics,actions,onCopyError}:{card:ExtensionTokenIdentity;metrics?:Pick<TokenCard,'marketCap'|'volume'>;actions:React.ReactNode;onCopyError:()=>void}){
  const hasDistinctName = card.name && card.symbol && card.name.trim().toLowerCase() !== card.symbol.trim().toLowerCase();
  return <div className="token-row">
    <TokenThumbnail card={card}/>
    <div className="token-identity">
      <strong>{card.symbol || card.name || short(card.address)}</strong>
      {hasDistinctName && <span>{card.name}</span>}
      <button className="address" title="Copy contract address" onClick={()=>void navigator.clipboard.writeText(card.address).catch(onCopyError)}>
        {short(card.address)}<Icon name="copy"/>
      </button>
    </div>
    <dl className="token-metrics">
      <div title="Market cap"><dt>MC</dt><dd style={{color:cardMetricColor(metrics?.marketCap)}}>{metrics?.marketCap?.value??'—'}</dd></div>
      <div title="Volume"><dt>V</dt><dd style={{color:cardMetricColor(metrics?.volume)}}>{metrics?.volume?.value??'—'}</dd></div>
    </dl>
    <div className="token-actions">
      {actions}
      <a className="gmgn-link" href={`https://gmgn.ai/bsc/token/${card.address}`} target="_blank" rel="noopener noreferrer" title="Open token on GMGN" aria-label="Open token on GMGN">
        <img src="assets/gmgn.png" alt=""/>
      </a>
    </div>
  </div>;
}
function Panel(){
  const[state,setState]=useState(empty),[view,setView]=useState<PopupUi['view']>('matches'),[destination,setDestination]=useState<Destination>('tokens'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const mainRef=useRef<HTMLElement>(null);
  const selectedGroupRef=useRef<HTMLElement>(null);
  const chosenDestination=useRef(false),firstState=useRef(true);
  const[note,setNote]=useState<PopupUi['editor']>(null),inFlight=useRef(false),mutationEpoch=useRef(0),uiOwner=useRef<string|undefined>(undefined),chosenView=useRef<PopupUi['view']|null>(null);
  const clearAccountReturn=()=>{if(isExtension)void browserApi.storage.session.remove(accountReturnKey).catch(()=>{});};
  const navigate=(next:Destination)=>{
    chosenDestination.current=true;
    if(next!=='profile')clearAccountReturn();
    setDestination(next);
  };
  const remember=(patch:Partial<PopupUi>,ownerId=uiOwner.current)=>{if(ownerId)void requestBackground({kind:'ui',ownerId,patch}).catch(()=>setError('Could not keep this draft locally. Save it before closing.'));};
  const changeView=(next:PopupUi['view'])=>{chosenView.current=next;setView(next);navigate('tokens');remember({view:next});};
  const changeNote=(editor:PopupUi['editor'])=>{setNote(editor);remember({editor});};
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const epoch = mutationEpoch.current;
    try {
      const result = await requestBackground<State>({kind:'state'});
      if (epoch !== mutationEpoch.current) return;
      if (firstState.current) {
        const stored=await (isExtension?browserApi.storage.session.get(accountReturnKey).catch(()=>null):null);
        if (epoch !== mutationEpoch.current) return;
        firstState.current=false;
        const returning=Number(stored?.[accountReturnKey])>Date.now();
        if (!chosenDestination.current && (returning || result.pending?.method==='email' || result.pending?.method==='google')) {
          setDestination('profile');
        }
        if (returning && result.connected) clearAccountReturn();
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
      setState(result);
      setRefreshFailed(false);
    } catch {
      if (epoch === mutationEpoch.current) setRefreshFailed(true);
    } finally {
      inFlight.current = false;
    }
  };
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{mainRef.current?.scrollTo(0,0);},[destination,view]);
  useEffect(()=>{
    const page=(event:Event)=>setState(current=>({...current,page:(event as CustomEvent).detail}));
    const focus=(event:Event)=>{setState(current=>({...current,selected:(event as CustomEvent).detail}));changeView('matches');};
    const update=(message:any,sender:any)=>{if(sender.id!==browserApi.runtime.id||sender.tab)return;if(message?.kind==='panel/changed')void refresh();if(message?.kind==='panel/focus'){setState(current=>({...current,selected:message.groupId}));changeView('matches');void refresh();}};
    if(isExtension)browserApi.runtime.onMessage.addListener(update);
    else{window.addEventListener('kollens:live-page',page);window.addEventListener('kollens:live-focus',focus);}
    return()=>{if(isExtension)browserApi.runtime.onMessage.removeListener(update);else{window.removeEventListener('kollens:live-page',page);window.removeEventListener('kollens:live-focus',focus);}};
  },[]);
  const action=async(message:Record<string,unknown>)=>{
    const epoch=++mutationEpoch.current;
    setBusy(true);
    setError('');
    try {
      await requestBackground({...message,ownerId:uiOwner.current});
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
  const cards=state.page?.cards??[],groups=state.page?.groups??[],unique=new Map<string,TokenCard>();
  const linkedAddresses = new Set<string>();
  for (const card of cards) {
    const otherCard = unique.get(card.address);
    unique.set(card.address, {
      ...card,
      logoUrl: card.logoUrl ?? otherCard?.logoUrl ?? null,
      marketCap: card.marketCap ?? otherCard?.marketCap,
      volume: card.volume ?? otherCard?.volume,
    });
    if (card.socialLinks.length) linkedAddresses.add(card.address);
  }
  const save=(card:ExtensionTokenIdentity)=>{if(!state.connected){setError('Connect your Kollens account to save tokens.');return;}
    const saved=state.workspace?.items.find(i=>i.address===card.address);void action({kind:'edit',item:{chainId:56,address:card.address,name:card.name,symbol:card.symbol,logoUrl:card.logoUrl??saved?.logoUrl??null,pinned:true,note:saved?.note??''}});};
  const choose=(groupId:string)=>{
    if (!groups.some(group=>group.id===groupId)) return;
    changeView('matches');
    setState(current=>({...current,selected:groupId}));
    void action({kind:'select',groupId});
  };
  useEffect(()=>{
    if(view==='matches'&&destination==='tokens')selectedGroupRef.current?.scrollIntoView({block:'nearest'});
  },[view,destination,state.selected]);
  const preferences=(patch:Partial<ExtensionPreferences>)=>{const next={...state.preferences,...patch};setState(current=>({...current,preferences:next,...('sound'in patch?{soundActivated:patch.sound}:{})}));void action({kind:'preferences',preferences:next,activateSound:patch.sound===true});};
  const shownItems=new Map(state.workspace?.items.map(item=>[item.address,{...item,local:false}])??[]);
  for(const draft of state.drafts)if(draft.item)shownItems.set(draft.address,{...draft.item,revision:draft.revision,updatedAt:'',local:true});
  const unavailableCount = unique.size - linkedAddresses.size;
  const showTrenchesLink = !state.canScanPage && (!state.page || state.page.status === 'disabled');
  const canEnableLive = state.canScanPage && state.localLiveAvailable && !state.liveEnabled;
  const canScanManually = state.canScanPage && !state.localLiveAvailable;
  const copyError=()=>setError('Copy failed');
  const demoConnect = state.demoAccount && !state.authOptions?.google && !state.authOptions?.email;
  const connect = <button className="popup-action" disabled={busy || Boolean(demoConnect && state.pending)}
    onClick={()=>demoConnect ? void action({kind:'connect'}) : navigate('profile')}>
    {demoConnect ? 'Connect Kollens' : 'Sign in'}
  </button>;
  return <div className="workspace">
    <header className="popup-header">
      {destination==='tokens'
        ? <img className="brand-logo" src="assets/kollens-logo.svg" alt="Kollens"/>
        : <><img className="brand-mark" src="assets/icon.png" alt="Kollens"/><h1>{destination==='profile' ? 'Account' : destinations.find(item=>item.id===destination)?.label}</h1></>}
      {destination==='wallets'&&<span className="network-pill"><img src="assets/bnb-chain.svg" alt=""/>BNB</span>}
      {destination==='tokens'&&!state.gmgnAuthorized&&<span className="preview-label">Local</span>}
    </header>
    {destination==='tokens'&&<nav className="workspace-tabs" aria-label="Workspace views">{(['matches','saved','activity']as const).map(tab=><button key={tab} className={view===tab?'active':''} aria-current={view===tab?'page':undefined} onClick={()=>changeView(tab)}>{tab[0].toUpperCase()+tab.slice(1)}<span>{tab==='matches'?groups.length:tab==='saved'?shownItems.size:state.page?.alerts.length??0}</span></button>)}</nav>}
    {error&&<div role="alert" className="feedback">{error}<button aria-label="Dismiss error" onClick={()=>setError('')}>×</button></div>}
    {destination!=='wallets'&&refreshFailed&&<div className="feedback refresh-feedback" role="status">
      <span>Connection interrupted. Retrying…</span>
      <button onClick={()=>void refresh()}>Retry now</button>
    </div>}
    {destination!=='wallets'&&state.error&&<p className="feedback" role="status">{state.error}</p>}
    <main ref={mainRef} className={`popup-main ${destination}-view`}>
    {destination==='wallets'&&<WalletsView/>}
    {destination==='profile'&&<AccountView user={state.connected ? state.workspace?.user : undefined}
      options={state.authOptions} pending={state.pending} demo={state.demoAccount===true} busy={busy}
      action={accountAction} onCopyError={copyError}/>}
    {destination==='settings'&&<section className="settings"><div className="settings-group"><h2>Match settings</h2><label><input type="checkbox" checked={state.preferences.highlights} onChange={e=>preferences({highlights:e.target.checked})}/>Highlight matching cards</label>
      {extensionMatchTypes.map(type=><label key={type}><input type="checkbox" checked={state.preferences.matchTypes.includes(type)} onChange={e=>preferences({matchTypes:e.target.checked?[...state.preferences.matchTypes,type]:state.preferences.matchTypes.filter(t=>t!==type)})}/>{extensionLabels[type]}</label>)}
      </div><div className="settings-group"><h2>Page alerts</h2>{(['newGroups','newMembers','watchedOnly','sound']as const).map(key=><label key={key}><input type="checkbox" checked={key==='sound'?state.preferences.sound&&Boolean(state.soundActivated):state.preferences[key]} onChange={e=>preferences({[key]:e.target.checked})}/>{{newGroups:'New matching groups',newMembers:'New tokens joining a group',watchedOnly:'Only groups with saved tokens',sound:'Enable alert sound'}[key]}</label>)}
      </div>
      </section>}
    {destination==='settings'&&state.preferenceDraft?.conflict&&<div className="conflict">Settings changed on another browser.<button onClick={()=>void action({kind:'resolvePreferences',choice:'server'})}>Use synced settings</button><button onClick={()=>void action({kind:'resolvePreferences',choice:'mine'})}>Keep my settings</button></div>}
    {destination==='tokens'&&<>
      {view==='matches'&&<div className="match-stack">
        {canEnableLive&&<div className="empty"><button className="scan-button" disabled={busy} onClick={()=>void enableLive()}>Enable on GMGN</button></div>}
        {canScanManually&&<div className="scan-action"><button className="scan-button" disabled={busy} onClick={()=>void action({kind:'scan'})}>Scan this tab</button></div>}
        {groups.length?groups.map(group=><section ref={state.selected===group.id?selectedGroupRef:undefined} className={`group ${state.selected===group.id?'selected':''}`} key={group.id} style={{'--group-color':group.color}as React.CSSProperties}>
          <div className="group-header">
            <button className="group-heading" onClick={()=>choose(group.id)}>
              <span className="group-marker"/><strong>{extensionLabels[group.type]}</strong><span>{group.addresses.length} tokens</span>
            </button>
            <a className="source-link" href={group.url} target="_blank" rel="noopener noreferrer" title="Open source link" aria-label={`Open source link for ${extensionLabels[group.type]}`}><Icon name="external"/></a>
          </div>
          <div className="token-stack">
            {group.addresses.map(address=>{
              const card = unique.get(address);
              if (!card) return null;
              const saved = state.saved.includes(address);
              return <TokenRow key={address} card={card} metrics={card} onCopyError={copyError} actions={
                <button title={saved?'Token saved':'Save token'} aria-label={`Save ${card.symbol||card.name}`} className={saved?'is-saved':''} onClick={()=>save(card)}><Icon name="star"/></button>
              }/>;
            })}
          </div>
        </section>):showTrenchesLink?<a className="trenches-empty" href="https://gmgn.ai/?chain=bsc" target="_blank" rel="noopener noreferrer">
          <img src="assets/gmgn.png" alt=""/>
          <span>Open GMGN BNB trenches to find matches</span>
        </a>:(canEnableLive||(canScanManually&&!state.page))?null:<div className="empty"><h2>{emptyMatches(state,unique.size>0)}</h2></div>}
        {unavailableCount>0&&<p className="coverage">{unavailableCount} {unavailableCount===1?'token':'tokens'} · links unavailable</p>}
      </div>}
      {view==='saved'&&<>
        {!state.connected&&<div className="empty"><h2>Connect to save tokens</h2>{connect}</div>}
        {shownItems.size>0&&<div className="saved-stack token-stack">
          {[...shownItems.values()].map(item=>{
            const draft = state.drafts.find(d=>d.address===item.address);
            const card = {...item,logoUrl:unique.get(item.address)?.logoUrl??item.logoUrl};
            const syncStatus = draft?.conflict?'Note needs review':draft?.error??(item.local?'Not synced':null);
            return <section className="saved-item" key={item.address}>
              <TokenRow card={card} metrics={unique.get(item.address)} onCopyError={copyError} actions={<>
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
        {state.connected&&!shownItems.size&&<div className="empty"><h2>No saved tokens</h2></div>}
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
    {destination==='tokens'&&note&&<div className="note-editor" role="dialog" aria-label="Private token note"><div><h2>{note.identity.symbol||note.identity.name}</h2><span>Private note</span></div><textarea autoFocus maxLength={2000} value={note.text} onChange={e=>changeNote({...note,text:e.target.value,dirty:true})}/><small>{note.text.length}/2000</small><div><button onClick={()=>{if(!note.dirty||confirm('Discard this unsaved note draft?'))changeNote(null);}}>Cancel</button><button className="primary" disabled={busy} onClick={()=>{void action({kind:'edit',item:{chainId:56,address:note.identity.address,name:note.identity.name,symbol:note.identity.symbol,pinned:true,note:note.text}}).then(success=>{if(success)changeNote(null);});}}>Save note</button></div></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Panel/>);
