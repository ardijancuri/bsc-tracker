import {useCallback, useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {Archive, ArrowDownLeft, ArrowDownToLine, ArrowUpRight, ChevronDown, ChevronUp, Copy, Ellipsis, KeyRound, Pencil, Plus, RefreshCw, RotateCcw, WalletCards} from 'lucide-react';
import {isExtension} from './platform';
import {formatWalletBalance, useWalletBalances} from './useWalletBalances';
import {WalletTransferView} from './WalletTransferView';
import {createLocalWallet, exportLocalWallet, importLocalWallet, listLocalWallets, maximumWalletAliasLength, minimumWalletPasswordLength, updateLocalWallet, type LocalWallet} from './walletVault';

const shortAddress = (address: string) => `${address.slice(0,6)}…${address.slice(-4)}`;

type WalletEditorAction =
  | {kind:'import'}
  | {kind:'backup'|'alias'; wallet:LocalWallet};
type WalletAction = WalletEditorAction
  | {kind:'receive'; wallet:LocalWallet}
  | {kind:'send'; wallet:LocalWallet};

function WalletEditor({action,onClose,onSaved}: {
  action:WalletEditorAction;
  onClose:()=>void;
  onSaved:(wallet:LocalWallet,message:string)=>void;
}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [backup,setBackup] = useState('');
  const active = useRef(false);
  const operation = useRef(false);
  const heading = action.kind==='import'?'Import wallet':action.kind==='alias'?'Edit alias':'View private key';
  const needsPassword = action.kind==='import'||(action.kind==='backup'&&action.wallet.protection==='password');

  useEffect(()=>{
    active.current=true;
    const hideKey=()=>{if(document.hidden)setBackup('');};
    document.addEventListener('visibilitychange',hideKey);
    return ()=>{
      active.current=false;
      document.removeEventListener('visibilitychange',hideKey);
    };
  },[]);

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current) return;
    const fields = new FormData(event.currentTarget);
    const password = String(fields.get('password') ?? '');
    if (action.kind!=='alias') event.currentTarget.reset();
    if (action.kind==='import'&&password!==fields.get('confirm')) {
      setError('Wallet passwords do not match.');
      return;
    }
    operation.current=true;
    setBusy(true);
    setError('');
    try {
      if (action.kind==='backup') {
        const key = await exportLocalWallet(action.wallet.address, needsPassword?password:undefined);
        if (active.current&&!document.hidden) setBackup(key);
      } else if (action.kind==='alias') {
        const wallet = await updateLocalWallet(action.wallet.address,{alias:String(fields.get('alias') ?? '')});
        if (active.current) onSaved(wallet,'Wallet alias saved.');
      } else {
        const wallet = await importLocalWallet(String(fields.get('secret') ?? ''),password);
        if (active.current) onSaved(wallet,'Wallet imported.');
      }
    } catch (failure) {
      if (active.current) setError(failure instanceof Error?failure.message:'Could not manage this wallet.');
    } finally {
      operation.current=false;
      if (active.current) setBusy(false);
    }
  }

  return <section className="wallet-card wallet-editor" aria-label={heading}>
    <h2>{heading}</h2>
    {backup
      ? <>
        <p>This key gives full control of your wallet. Keep your backup private.</p>
        <label htmlFor="wallet-backup-key">Private key</label>
        <textarea id="wallet-backup-key" readOnly value={backup} spellCheck={false} onFocus={event=>event.currentTarget.select()}/>
        <button className="popup-action" onClick={onClose}>Hide private key</button>
      </>
      : <form onSubmit={submit} autoComplete="off">
        {action.kind==='import'&&<label>Private key or recovery phrase
          <input name="secret" type="password" required maxLength={512} autoComplete="off" spellCheck={false}/>
          <small>A recovery phrase imports its first standard EVM address.</small>
        </label>}
        {action.kind==='alias'&&<label>Wallet alias
          <input name="alias" maxLength={maximumWalletAliasLength} defaultValue={action.wallet.alias} placeholder="Optional name"/>
        </label>}
        {action.kind==='backup'&&<p>This key gives full control of your wallet. Reveal it only when you can keep it private.</p>}
        {needsPassword&&<label>Wallet password
          <input name="password" type="password" required minLength={minimumWalletPasswordLength} maxLength={1024}
            autoComplete="off"/>
        </label>}
        {action.kind==='import'&&<>
          <label>Confirm password
            <input name="confirm" type="password" required minLength={minimumWalletPasswordLength} maxLength={1024} autoComplete="off"/>
          </label>
          <p>Use at least {minimumWalletPasswordLength} characters.</p>
        </>}
        {error&&<p role="alert" className="wallet-error">{error}</p>}
        <div className="wallet-actions">
          <button className="popup-action secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="popup-action" type="submit" disabled={busy}>
            {busy?'Working…':action.kind==='backup'?'Show private key':action.kind==='alias'?'Save alias':heading}
          </button>
        </div>
      </form>}
  </section>;
}

function WalletRecord({wallet,balance,menuOpen,onMenu,onAction,onArchive,onCopy}:{
  wallet:LocalWallet;
  balance:bigint|undefined;
  menuOpen:boolean;
  onMenu:(address:string|null)=>void;
  onAction:(action:WalletAction)=>void;
  onArchive:()=>void;
  onCopy:()=>void;
}) {
  const [expanded,setExpanded] = useState(true);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const address = shortAddress(wallet.address);
  const label = wallet.alias||address;
  const menuId = `wallet-options-${wallet.address}`;
  const balanceText = balance===undefined?'—':formatWalletBalance(balance);

  useEffect(()=>{
    if (!menuOpen) return;
    const options=menu.current;
    const boundary=options?.closest('.popup-main')?.getBoundingClientRect();
    if (options&&boundary) {
      const rect=options.getBoundingClientRect();
      const anchor=menuButton.current?.getBoundingClientRect();
      if (anchor&&rect.bottom>boundary.bottom&&anchor.top-rect.height>=boundary.top) {
        options.classList.add('wallet-menu-above');
      } else {
        options.scrollIntoView({block:'nearest'});
      }
    }
    function dismiss(event:PointerEvent) {
      if (!trigger.current?.contains(event.target as Node)) onMenu(null);
    }
    function closeWithEscape(event:KeyboardEvent) {
      if (event.key==='Escape') {
        onMenu(null);
        menuButton.current?.focus();
      }
    }
    document.addEventListener('pointerdown',dismiss);
    document.addEventListener('keydown',closeWithEscape);
    return ()=>{
      document.removeEventListener('pointerdown',dismiss);
      document.removeEventListener('keydown',closeWithEscape);
    };
  },[menuOpen,onMenu]);

  return <section className="wallet-record" aria-label={`Wallet ${label}`}>
    <div className="wallet-record-head">
      <div className="wallet-record-identity">
        <input type="checkbox" className="wallet-record-select" aria-label={`Select wallet ${label}`}/>
        <button type="button" className="wallet-record-address" onClick={onCopy} title={`Copy ${wallet.address}`} aria-label={`Copy wallet address ${label}`}>
          <span>{label}</span><Copy size={12} aria-hidden="true"/>
        </button>
      </div>
      {!wallet.archived&&<span className="wallet-record-balance"><img src="assets/bnb-chain.svg" alt=""/>{balanceText}</span>}
      <div ref={trigger} className="wallet-menu-anchor">
        <button ref={menuButton} type="button" className="wallet-icon-button" aria-label={`Wallet options for ${label}`}
          aria-expanded={menuOpen} aria-controls={menuOpen?menuId:undefined} onClick={()=>onMenu(menuOpen?null:wallet.address)}>
          <Ellipsis size={16} aria-hidden="true"/>
        </button>
        {menuOpen&&<div ref={menu} id={menuId} className="wallet-menu" aria-label="Wallet options">
          {!wallet.archived&&<div className="wallet-menu-group">
            <button onClick={()=>onAction({kind:'receive',wallet})}><ArrowDownLeft size={14} aria-hidden="true"/>Receive</button>
            <button onClick={()=>onAction({kind:'send',wallet})}><ArrowUpRight size={14} aria-hidden="true"/>Send</button>
          </div>}
          <div className="wallet-menu-group">
            <a href={`https://bscscan.com/address/${wallet.address}`} target="_blank" rel="noreferrer" onClick={()=>onMenu(null)}>
              <img src="assets/bnb-chain.svg" alt=""/>View on BscScan <ArrowUpRight className="wallet-menu-external" size={12} aria-hidden="true"/>
            </a>
            <button onClick={()=>onAction({kind:'alias',wallet})}><Pencil size={14} aria-hidden="true"/>Edit alias</button>
          </div>
          <div className="wallet-menu-group">
            <button onClick={()=>onAction({kind:'backup',wallet})}><KeyRound size={14} aria-hidden="true"/>View private key</button>
            <button onClick={onArchive}>{wallet.archived?<RotateCcw size={14} aria-hidden="true"/>:<Archive size={14} aria-hidden="true"/>}
              {wallet.archived?'Restore wallet':'Archive wallet'}
            </button>
          </div>
        </div>}
      </div>
      {!wallet.archived&&<button type="button" className="wallet-icon-button" aria-label={expanded?'Collapse wallet':'Expand wallet'}
        aria-expanded={expanded} aria-controls={`wallet-assets-${wallet.address}`} onClick={()=>{onMenu(null);setExpanded(value=>!value);}}>
        {expanded?<ChevronUp size={14} aria-hidden="true"/>:<ChevronDown size={14} aria-hidden="true"/>}
      </button>}
    </div>
    {!wallet.archived&&<div id={`wallet-assets-${wallet.address}`} hidden={!expanded} className="wallet-record-assets">
      <div>{wallet.alias&&<code title={wallet.address}>{address}</code>}
        <p>{balance===0n?'No BNB balance':'BNB Chain wallet'}</p>
      </div>
      <button className="popup-action" onClick={()=>onAction({kind:'receive',wallet})}>Deposit</button>
    </div>}
  </section>;
}

export function WalletsView() {
  const [wallets,setWallets] = useState<LocalWallet[]>([]);
  const [ready,setReady] = useState(!isExtension);
  const [action,setAction] = useState<WalletAction|null>(null);
  const [menuWallet,setMenuWallet] = useState<string|null>(null);
  const [showArchived,setShowArchived] = useState(false);
  const [creating,setCreating] = useState(false);
  const [feedback,setFeedback] = useState('');
  const operation = useRef(false);
  const changeMenu = useCallback((address:string|null)=>setMenuWallet(address),[]);
  const activeWallets = useMemo(()=>wallets.filter(wallet=>!wallet.archived),[wallets]);
  const archivedWallets = wallets.filter(wallet=>wallet.archived);
  const {balances,totalBalance,balanceStatus,refreshBalance,refreshGrantedBalances} = useWalletBalances(activeWallets);

  useEffect(()=>{
    if (!isExtension) return;
    let active=true;
    void listLocalWallets().then(items=>{
      if (active) {
        setWallets(items);
        setReady(true);
      }
    }).catch(()=>{if (active) setFeedback('Could not open your wallet vault.');});
    return ()=>{active=false;};
  },[]);

  function openAction(next:WalletAction) {
    setMenuWallet(null);
    setFeedback('');
    setAction(next);
  }

  function save(wallet:LocalWallet,message:string) {
    setWallets(current=>current.some(item=>item.address===wallet.address)
      ? current.map(item=>item.address===wallet.address?wallet:item)
      : [wallet,...current]);
    setAction(null);
    setFeedback(message);
  }

  async function create() {
    if (operation.current) return;
    operation.current=true;
    setCreating(true);
    setFeedback('');
    setMenuWallet(null);
    try {
      save(await createLocalWallet(),'Wallet created. Back up its private key before adding funds.');
    } catch (failure) {
      setFeedback(failure instanceof Error?failure.message:'Could not create a wallet.');
    } finally {
      operation.current=false;
      setCreating(false);
    }
  }

  async function archive(wallet:LocalWallet) {
    if (operation.current) return;
    operation.current=true;
    setMenuWallet(null);
    try {
      const updated = await updateLocalWallet(wallet.address,{archived:!wallet.archived});
      save(updated,updated.archived?'Wallet archived. You can restore it below.':'Wallet restored.');
    } catch {
      setFeedback('Could not update this wallet.');
    } finally {
      operation.current=false;
    }
  }

  function renderWallet(wallet:LocalWallet) {
    return <WalletRecord key={wallet.address} wallet={wallet} balance={balances.get(wallet.address)}
      menuOpen={menuWallet===wallet.address} onMenu={changeMenu}
      onAction={openAction} onArchive={()=>void archive(wallet)}
      onCopy={()=>void navigator.clipboard.writeText(wallet.address)
        .then(()=>setFeedback('Address copied.')).catch(()=>setFeedback('Could not copy address.'))}/>;
  }

  const balanceMessage = balanceStatus==='partial'?'Some wallet balances are unavailable.'
    : balanceStatus==='unavailable'?'BNB balances are unavailable. Try refreshing.':'';
  return <div className="wallet-layout">
    <section className="wallet-balance">
      <p>{archivedWallets.length?'BNB · Active wallet balance':'BNB · Total balance'}</p>
      <div>
        <strong>{ready&&totalBalance!==null?formatWalletBalance(totalBalance):'—'}</strong>
        {activeWallets.length>0&&(
          balanceStatus==='permission_required'
            ? <button className="popup-action wallet-enable-balances" onClick={refreshBalance}>Enable balances</button>
            : <button className="wallet-icon-button" aria-label="Refresh BNB balance" title="Refresh BNB balance"
                disabled={balanceStatus==='loading'} onClick={refreshBalance}><RefreshCw size={14} aria-hidden="true"/></button>
        )}
      </div>
      {balanceMessage&&<small role="status">{balanceMessage}</small>}
    </section>
    {ready&&!action&&activeWallets.length>0&&<div className="wallet-toolbar">
      <button className="popup-action secondary" disabled={creating} onClick={()=>void create()}><Plus size={14} aria-hidden="true"/>{creating?'Creating…':'Wallet'}</button>
      <button className="popup-action secondary" disabled={creating} onClick={()=>openAction({kind:'import'})}><ArrowDownToLine size={14} aria-hidden="true"/>Import</button>
    </div>}
    {feedback&&<p className="wallet-feedback" role="status">{feedback}</p>}
    {action&&(action.kind==='receive'||action.kind==='send'
      ? <WalletTransferView key={action.kind+action.wallet.address} kind={action.kind} wallet={action.wallet}
          onClose={()=>setAction(null)} onSent={refreshGrantedBalances}/>
      : <WalletEditor key={action.kind} action={action} onClose={()=>setAction(null)} onSaved={save}/>)}
    {!action&&ready&&activeWallets.length===0&&<section className="wallet-card wallet-empty">
      <div className="wallet-intro"><span className="wallet-intro-icon"><WalletCards size={18} aria-hidden="true"/></span><div>
        <h2>Get started with wallets</h2>
        <p>Create a BNB Chain wallet or import one you already use.</p>
      </div></div>
      <div className="wallet-actions">
        <button className="popup-action" disabled={!isExtension||creating} onClick={()=>void create()}>{creating?'Creating…':'Create wallet'}</button>
        <button className="popup-action secondary" disabled={!isExtension||creating} onClick={()=>openAction({kind:'import'})}><ArrowDownToLine size={14} aria-hidden="true"/>Import</button>
      </div>
      {!isExtension&&<p className="wallet-preview-note">Open the Chrome extension to manage wallets.</p>}
    </section>}
    {!action&&activeWallets.map(renderWallet)}
    {!action&&archivedWallets.length>0&&<div className="wallet-archive">
      <button className="popup-action secondary" aria-expanded={showArchived} onClick={()=>setShowArchived(value=>!value)}>
        <Archive size={13} aria-hidden="true"/>Archived wallets <span>{archivedWallets.length}</span>
      </button>
      {showArchived&&archivedWallets.map(renderWallet)}
    </div>}
  </div>;
}
