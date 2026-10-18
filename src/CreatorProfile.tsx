import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { useAccount } from './Account';
import { t, useLanguage } from './i18n';
import { CreatorWalletError, discoverCreatorWallets, signCreatorChallenge, type WalletChoice } from './creatorWallet';
import type { CreatorChallenge, CreatorErrorCode, CreatorStatus } from '../shared/creatorProfiles';
import './creatorProfile.css';

class CreatorRequestError extends Error {
  constructor(readonly code: CreatorErrorCode | 'unavailable' | 'image_invalid') { super(code); }
}
function creatorErrorText(error: unknown) {
  if (error instanceof CreatorWalletError) {
    if (error.code === 'no_wallet') return t('Open Kollens in your wallet browser or install a browser wallet extension.');
    if (error.code === 'wrong_chain') return t('Switch your wallet to BNB Smart Chain.');
    if (error.code === 'no_account') return t('No wallet account is available.');
    if (error.code === 'rejected') return t('Wallet signing was cancelled.');
    if (error.code === 'chain_missing') return t('Add BNB Smart Chain to your wallet and try again.');
    if (error.code === 'invalid_signature') return t('The wallet returned an invalid signature.');
    return t('The wallet could not sign. Reconnect your wallet and try again.');
  }
  const code = error instanceof CreatorRequestError ? error.code : 'unavailable';
  if (code === 'unauthorized' || code === 'account_changed') return t('Your account changed. Sign in again and reopen this profile.');
  if (code === 'wrong_origin') return t('Open Kollens from its configured website and try again.');
  if (code === 'not_tracked') return t('Only tracked KOLs can claim a creator profile.');
  if (code === 'already_claimed') return t('This KOL profile is already claimed.');
  if (code === 'not_owner') return t('Only the creator profile owner can edit this profile.');
  if (code === 'challenge_invalid') return t('This wallet challenge expired or was already used. Start again.');
  if (code === 'signature_invalid') return t('The signature does not prove control of this wallet.');
  if (code === 'wallet_unsupported') return t('This smart wallet does not support ERC-1271 signature verification.');
  if (code === 'rate_limited') return t('Too many attempts. Wait a minute and try again.');
  if (code === 'image_invalid') return t('Choose a static JPEG, PNG or WebP up to 2 MB.');
  if (code === 'invalid_input') return t('Check your profile fields and use valid HTTPS links.');
  return t('Creator profiles are temporarily unavailable. Try again.');
}
async function creatorRequest<T>(wallet: string, path = '', body?: object, method = 'POST', owner?: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(60000);
  const response = await fetch(`/api/kols/${encodeURIComponent(wallet)}/creator${path}`, { method: body ? method : 'GET', cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(owner ? { 'X-Watchlist-Owner': owner } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new CreatorRequestError(typeof result.code === 'string' ? result.code : 'unavailable');
  return result as T;
}

export function CreatorProfile({ wallet, onPublished }: { wallet: string; onPublished(): void }) {
  useLanguage();
  const account = useAccount();
  const [status, setStatus] = useState<CreatorStatus | null>(null), [editingFor, setEditingFor] = useState<string | null>(null);
  const request = useRef(0), ownerId = account.state.user?.id ?? null;
  const refresh = useCallback(async () => {
    const generation = ++request.current;
    try { const next = await creatorRequest<CreatorStatus>(wallet); if (generation === request.current) setStatus(next); }
    catch { if (generation === request.current) setStatus(null); }
  }, [wallet, ownerId]);
  useEffect(() => { setStatus(null); setEditingFor(null); void refresh(); return () => { request.current++; }; }, [refresh, account.revision]);
  if (!status) return null;
  return <section className="creator-profile" aria-label={t('Creator profile')}>
    <div className="creator-profile-heading">{status.claimed && <span className="creator-wallet-badge" title={t('This creator proved wallet control. Social accounts and trading results are not verified.')}><ShieldCheck size={15} />{t('Wallet control verified')}</span>}
      {status.canEdit ? <button type="button" disabled={account.checking || account.unavailable} onClick={() => setEditingFor(ownerId)}>{t('Edit profile')}</button> : !status.claimed && <button type="button" disabled={account.checking || account.unavailable} onClick={() => ownerId ? setEditingFor(ownerId) : void account.login()}>{t('Claim profile')}</button>}</div>
    {status.bio && <p className="creator-bio">{status.bio}</p>}
    <div className="creator-links">{([[status.websiteUrl, 'Website'], [status.xUrl, 'X'], [status.telegramUrl, 'Telegram']] as const).filter(([url]) => url).map(([url, label]) => <a href={url!} key={label} target="_blank" rel="noopener noreferrer">{t(label)}</a>)}</div>
    {editingFor && editingFor === ownerId && <CreatorEditor key={`${wallet}:${ownerId}`} wallet={wallet} ownerId={editingFor} status={status} close={() => setEditingFor(null)} saved={() => { void refresh(); onPublished(); }} />}
  </section>;
}

function CreatorEditor({ wallet, ownerId, status, close, saved }: { wallet: string; ownerId: string; status: CreatorStatus; close(): void; saved(): void }) {
  const account = useAccount(), currentOwner = useRef(account.state.user?.id);
  currentOwner.current = account.state.user?.id;
  const active = useRef(true), abort = useRef(new AbortController());
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const [wallets, setWallets] = useState<WalletChoice[]>([]), [selected, setSelected] = useState('');
  const [owned, setOwned] = useState(status.canEdit), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ displayName: status.displayName ?? '', bio: status.bio ?? '', websiteUrl: status.websiteUrl ?? '', xUrl: status.xUrl ?? '', telegramUrl: status.telegramUrl ?? '' });
  const [image, setImage] = useState<File | null>(null);
  useEffect(() => { active.current = true; if (abort.current.signal.aborted) abort.current = new AbortController();
    return () => { active.current = false; abort.current.abort(); }; }, []);
  useEffect(() => discoverCreatorWallets(wallet => setWallets(current => current.some(value => value.provider === wallet.provider) ? current : [...current, wallet])), []);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.current?.showModal(); return () => { dialog.current?.close(); document.body.style.overflow = overflow; previous?.focus(); }; }, []);
  const proof = async (action: 'claim' | 'release') => {
    const assertAccount = () => { if (!active.current || currentOwner.current !== ownerId) throw new CreatorRequestError('account_changed'); };
    assertAccount();
    const provider = (wallets.find(value => value.id === selected) ?? wallets[0])?.provider;
    if (!provider) throw new CreatorWalletError('no_wallet');
    const challenge = await creatorRequest<CreatorChallenge>(wallet, '/challenge', { action, chainId: 56 }, 'POST', ownerId, abort.current.signal);
    assertAccount();
    if (challenge.walletAddress.toLowerCase() !== wallet.toLowerCase() || challenge.chainId !== 56 || challenge.action !== action || Date.parse(challenge.expiresAt) <= Date.now()) throw new CreatorRequestError('challenge_invalid');
    const signature = await signCreatorChallenge(provider, wallet, challenge.message);
    assertAccount();
    await creatorRequest(wallet, `/${action}`, { challengeId: challenge.challengeId, signature }, 'POST', ownerId, abort.current.signal);
    assertAccount();
  };
  const operate = async (action: () => Promise<void>) => { setBusy(true); setError(null); try { await action(); } catch (problem) { if (active.current) setError(problem); } finally { if (active.current) setBusy(false); } };
  const save = () => operate(async () => {
    if (image) {
      if (image.size > 2 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) throw new CreatorRequestError('image_invalid');
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(image); });
      if (!active.current || currentOwner.current !== ownerId) throw new CreatorRequestError('account_changed');
      await creatorRequest(wallet, '/avatar', { mime: image.type, data }, 'POST', ownerId, abort.current.signal);
    }
    if (!active.current || currentOwner.current !== ownerId) throw new CreatorRequestError('account_changed');
    await creatorRequest(wallet, '', form, 'PATCH', ownerId, abort.current.signal);
    if (active.current && currentOwner.current === ownerId) { saved(); close(); }
  });
  return <dialog ref={dialog} className="creator-editor" aria-labelledby={title} onCancel={event => { if (busy) event.preventDefault(); else close(); }}>
    <header><h2 id={title}>{owned ? t('Edit profile') : t('Claim profile')}</h2><button type="button" disabled={busy} onClick={close} aria-label={t('Close')}><X size={20} /></button></header>
    <p className="creator-help">{owned ? t('Update your public identity and links. Trading statistics stay automatic.') : t('Prove control of this BNB wallet with a signature. This does not authorize a transaction or verify social accounts.')}</p>
    <code>{wallet}</code>
    {(!owned || wallets.length > 1) && <label>{t('Wallet')}<select value={selected || wallets[0]?.id || ''} onChange={event => setSelected(event.target.value)} disabled={busy}>{!wallets.length && <option>{t('No browser wallet found')}</option>}{wallets.map(value => <option key={value.id} value={value.id}>{value.name === 'Browser wallet' ? t('Browser wallet') : value.name}</option>)}</select></label>}
    {!owned && !wallets.length && <p className="creator-help">{t('Open Kollens in your wallet browser or install a browser wallet extension.')}</p>}
    {!owned ? <button className="creator-primary" type="button" disabled={busy || !wallets.length} onClick={() => void operate(async () => { await proof('claim'); setOwned(true); saved(); })}>{busy ? t('Waiting for wallet…') : t('Sign and claim')}</button> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{t('Display name')}<input value={form.displayName} maxLength={60} onChange={event => setForm({ ...form, displayName: event.target.value })} /></label>
      <label>{t('Short bio')}<textarea value={form.bio} maxLength={400} rows={3} onChange={event => setForm({ ...form, bio: event.target.value })} /></label>
      <label>{t('Profile image')}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setImage(event.target.files?.[0] ?? null)} /><small>{t('Static JPEG, PNG or WebP · 2 MB maximum')}</small></label>
      {(['websiteUrl', 'xUrl', 'telegramUrl'] as const).map(key => <label key={key}>{t(key === 'websiteUrl' ? 'Website' : key === 'xUrl' ? 'X link' : 'Telegram link')}<input type="url" placeholder="https://" value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}
      <div className="creator-editor-actions"><button className="creator-primary" disabled={busy} type="submit">{busy ? t('Saving…') : t('Save profile')}</button><button className="creator-release" type="button" title={!wallets.length ? t('Open Kollens in your wallet browser or install a browser wallet extension.') : undefined} disabled={busy || !wallets.length} onClick={() => void operate(async () => { await proof('release'); saved(); close(); })}>{t('Release claim')}</button></div>
    </form>}
    {error != null && <p role="alert" className="creator-error">{creatorErrorText(error)}</p>}
  </dialog>;
}
