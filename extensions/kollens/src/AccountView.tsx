import {useState, type FormEvent} from 'react';
import {Check, Copy, LogOut, Mail, Plus} from 'lucide-react';
import type {ExtensionAuthOptions, ExtensionWorkspace} from '../../../shared/extension';

export interface AccountPending {
  expiresAt: string;
  method?: 'google' | 'email' | 'web';
  email?: string;
}

type AccountAction =
  | {kind: 'connect' | 'disconnect' | 'google-connect' | 'cancel-pairing'}
  | {kind: 'email-start'; email: string}
  | {kind: 'email-verify'; email: string; code: string}
  | {kind: 'link-social'; provider: 'telegram' | 'x'};

interface AccountViewProps {
  user?: ExtensionWorkspace['user'];
  options?: ExtensionAuthOptions;
  pending?: AccountPending | null;
  demo: boolean;
  busy: boolean;
  action: (message: AccountAction) => Promise<boolean>;
  onCopyError: () => void;
}

function ConnectedAccount({user, options, busy, action, onCopyError}: Pick<AccountViewProps, 'options' | 'busy' | 'action' | 'onCopyError'> & {
  user: NonNullable<AccountViewProps['user']>;
}) {
  const [copied, setCopied] = useState(false);
  const identity = user.email || user.name;
  const telegram = user.telegramUsername ? '@' + user.telegramUsername : user.telegramLinked ? 'Linked' : '';
  const x = user.xUsername ? '@' + user.xUsername : '';
  const uid = user.id.length > 14 ? user.id.slice(0, 6) + '…' + user.id.slice(-5) : user.id;

  async function copyUid() {
    try {
      await navigator.clipboard.writeText(user.id);
      setCopied(true);
    } catch {
      onCopyError();
    }
  }

  return <div className="account-stack">
    <section className="account-card account-summary" aria-label="Connected Kollens account">
      <h2 title={identity}>{identity}</h2>
      {user.email && user.name && user.name !== identity && <p className="account-display-name">{user.name}</p>}
      <div className="account-meta">
        <button type="button" className="account-action account-uid" aria-label="Copy account UID" onClick={() => void copyUid()}>
          <span>UID {uid}</span>
          {copied ? <Check size={14} aria-hidden="true"/> : <Copy size={14} aria-hidden="true"/>}
        </button>
        <span className="account-copy-status" role="status">{copied ? 'Account UID copied' : ''}</span>
        <button type="button" className="account-action" disabled={busy} onClick={() => void action({kind: 'disconnect'})}>
          Log out <LogOut size={14} aria-hidden="true"/>
        </button>
      </div>
    </section>
    <section className="account-card account-connections" aria-label="Social accounts">
      <dl>
        <div>
          <dt>Telegram</dt>
          <dd className={telegram ? 'linked' : undefined}>{telegram || (options?.telegram
            ? <button type="button" className="account-action" disabled={busy} aria-label="Link Telegram"
                onClick={() => void action({kind: 'link-social', provider: 'telegram'})}>
                Link <Plus size={14} aria-hidden="true"/>
              </button>
            : 'Not linked')}</dd>
        </div>
        <div>
          <dt>Twitter/X</dt>
          <dd className={x ? 'linked' : undefined}>{x || (options?.x
            ? <button type="button" className="account-action" disabled={busy} aria-label="Connect X"
                onClick={() => void action({kind: 'link-social', provider: 'x'})}>Connect</button>
            : 'Not linked')}</dd>
        </div>
      </dl>
      {options && ((!telegram && !options.telegram) || (!x && !options.x)) && <p>Some account connections are unavailable.</p>}
    </section>
  </div>;
}

export function AccountView({user, options, pending, demo, busy, action, onCopyError}: AccountViewProps) {
  const [emailOpen, setEmailOpen] = useState(false);
  const emailAttempt = pending?.method === 'email' && pending.email ? pending : null;
  const codeEmail = emailAttempt?.email;
  const showEmailForm = Boolean(codeEmail || (emailOpen && options?.email));
  const useDemoPairing = demo && !options?.google && !options?.email;

  if (user) return <ConnectedAccount key={user.id} user={user} options={options} busy={busy} action={action} onCopyError={onCopyError}/>;

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (codeEmail) {
      const code = String(data.get('code') ?? '').trim();
      void action({kind: 'email-verify', email: codeEmail, code}).then(success => {
        if (success) setEmailOpen(false);
      });
    } else {
      void action({kind: 'email-start', email: String(data.get('email') ?? '').trim()});
    }
  }

  async function cancel() {
    if (!pending || await action({kind: 'cancel-pairing'})) setEmailOpen(false);
  }

  return <section className="account-card account-signin" aria-label="Sign in">
    <h2>Sign in to Kollens</h2>
    <p>Sync saved tokens, notes and alert settings.</p>
    {pending && !codeEmail ? <div className="account-signin-actions">
      <p role="status">{pending.method === 'google' ? 'Finish signing in with Google.' : 'Finish connecting your account.'}</p>
      <button type="button" className="account-action" onClick={() => void cancel()}>Cancel</button>
    </div> : showEmailForm ? <form key={codeEmail ? emailAttempt?.expiresAt : 'email'} className="account-email" onSubmit={submitEmail}>
      {codeEmail ? <>
        <p className="account-code-destination">Sent to {codeEmail}</p>
        <label>
          Verification code
          <input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy} autoFocus/>
        </label>
      </> : <label>
        Email address
        <input name="email" type="email" autoComplete="email" placeholder="you@example.com" maxLength={254} required disabled={busy} autoFocus/>
      </label>}
      <div className="account-form-actions">
        <button type="submit" className="popup-action" disabled={busy}>{codeEmail ? 'Verify code' : 'Send code'}</button>
        <button type="button" className="account-action" disabled={busy} onClick={() => void cancel()}>{codeEmail ? 'Cancel' : 'Back'}</button>
      </div>
    </form> : <div className="account-signin-actions">
      {options?.google && <button type="button" className="popup-action account-provider" disabled={busy} onClick={() => void action({kind: 'google-connect'})}>
        Continue with Google
      </button>}
      {options?.email && <button type="button" className="popup-action account-provider secondary" disabled={busy} onClick={() => setEmailOpen(true)}>
        <Mail size={15} aria-hidden="true"/>Continue with email
      </button>}
      {useDemoPairing && <button type="button" className="popup-action" disabled={busy} onClick={() => void action({kind: 'connect'})}>Connect Kollens</button>}
      {!useDemoPairing && !options?.google && !options?.email && <p role="status">{options ? 'Sign-in is unavailable.' : 'Checking sign-in options…'}</p>}
    </div>}
  </section>;
}
