import {useEffect, useState, type FormEvent} from 'react';
import {useAccount} from './Account';

const loginPaths = {google:'/api/auth/google', email:'/api/auth/email'};

async function postJson(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body), signal:AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(()=>null);
  if (!response.ok) {
    const message = typeof result?.error==='string'?result.error:'Request failed. Try again.';
    throw Error(message);
  }
  return result;
}

async function loginAvailable(path: string, property: 'enabled'|'available', signal: AbortSignal) {
  try {
    const response = await fetch(`${path}/status`, {
      cache:'no-store', signal:AbortSignal.any([signal,AbortSignal.timeout(8000)]),
    });
    return response.ok && (await response.json())?.[property]===true;
  } catch {
    return false;
  }
}

function ExtensionSignIn({id, onError}: {id:string;onError:(message:string)=>void}) {
  const {state, login, busy:telegramBusy, refresh} = useAccount();
  const [providers,setProviders] = useState<{google:boolean;email:boolean}|null>(null);
  const [emailOpen,setEmailOpen] = useState(false);
  const [email,setEmail] = useState('');
  const [codeSent,setCodeSent] = useState(false);
  const [working,setWorking] = useState(false);

  useEffect(()=>{
    const controller = new AbortController();
    void Promise.all([
      loginAvailable(loginPaths.google,'enabled',controller.signal),
      loginAvailable(loginPaths.email,'available',controller.signal),
    ]).then(([google,email])=>{if(!controller.signal.aborted)setProviders({google,email});});
    return ()=>controller.abort();
  },[]);

  async function google() {
    setWorking(true);
    onError('');
    try {
      const result = await postJson(`${loginPaths.google}/start`,{id});
      const url = new URL(result?.url);
      if (url.origin!=='https://accounts.google.com' || url.username || url.password) throw Error('Google sign-in is unavailable.');
      window.location.assign(url.href);
    } catch (error) {
      onError(error instanceof Error?error.message:'Could not start Google sign-in.');
      setWorking(false);
    }
  }

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    onError('');
    try {
      if (codeSent) {
        const code = String(new FormData(event.currentTarget).get('code')??'');
        await postJson(`${loginPaths.email}/verify`,{id,email,code});
        await refresh();
      } else {
        await postJson(`${loginPaths.email}/start`,{id,email});
        setCodeSent(true);
      }
    } catch (error) {
      onError(error instanceof Error?error.message:'Email sign-in failed.');
    } finally {
      setWorking(false);
    }
  }

  return <>
    <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:20}}>
      <button className="button" disabled={working||!providers?.google} onClick={()=>void google()}>Continue with Google</button>
      <button className="button" disabled={working||!providers?.email} onClick={()=>{setEmailOpen(!emailOpen);onError('');}}>Continue with email</button>
      {state.enabled&&<button className="button" disabled={working||telegramBusy} onClick={()=>void login()}>Continue with Telegram</button>}
    </div>
    {providers&&(!providers.google||!providers.email)&&<p role="status" style={{marginTop:12}}>
      {!providers.google&&!providers.email?'Google and email sign-in are unavailable on this server.':!providers.google?'Google sign-in is unavailable on this server.':'Email sign-in is unavailable on this server.'}
    </p>}
    {emailOpen&&providers?.email&&<form onSubmit={submitEmail} style={{display:'grid',gap:10,justifyItems:'start',marginTop:20}}>
      {codeSent
        ? <>
          <p>Enter the code sent to <strong>{email}</strong>.</p>
          <label>Verification code <input name="code" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6}/></label>
        </>
        : <label>Email address <input type="email" name="email" autoComplete="email" required maxLength={254}
          disabled={working} value={email} onChange={event=>setEmail(event.target.value)}/></label>}
      <div style={{display:'flex',gap:8}}>
        <button className="button" disabled={working} type="submit">{codeSent?'Verify code':'Send code'}</button>
        {codeSent&&<button className="button" disabled={working} type="button" onClick={()=>{setCodeSent(false);onError('');}}>Send a new code</button>}
      </div>
    </form>}
  </>;
}

export function ExtensionConnect() {
  const {state,loaded,logout,busy} = useAccount();
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const googleError = params.get('googleError');
  const [attempt,setAttempt] = useState<{user:{id:string;name:string};extensionOrigin:string}|null>(null);
  const [error,setError] = useState(googleError==='cancelled'?'Google sign-in was cancelled.':googleError==='failed'?'Could not sign in with Google. Try again.':'');
  const [approved,setApproved] = useState(false);
  const [approving,setApproving] = useState(false);

  useEffect(()=>{
    setAttempt(null);
    if (!state.user || !id) return;
    const controller = new AbortController();
    void fetch(`/api/extension/auth/attempt/${encodeURIComponent(id)}`,{cache:'no-store',signal:controller.signal})
      .then(async response=>{
        const value = await response.json();
        if (!response.ok) throw Error(value.error??'Connection unavailable');
        if (!controller.signal.aborted) setAttempt(value);
      }).catch(failure=>{if(!controller.signal.aborted)setError(failure.message);});
    return ()=>controller.abort();
  },[state.user?.id,id]);

  async function approve() {
    if (!attempt || approving) return;
    setApproving(true);
    setError('');
    try {
      await postJson('/api/extension/auth/approve',{id,expectedUserId:attempt.user.id});
      setApproved(true);
    } catch (failure) {
      setError(failure instanceof Error?failure.message:'Connection failed');
    } finally {
      setApproving(false);
    }
  }

  return <section className="page" style={{maxWidth:580,padding:'60px 24px',margin:'auto'}}>
    <h1>{approved?'Extension connected':'Connect Kollens Extension'}</h1>
    {approved
      ? <p>Return to the extension popup. You may close this tab.</p>
      : <>
        <p>Your Kollens account syncs saved tokens, private notes and alert settings. Wallet keys stay on this browser.</p>
        {!id&&<p>Start the connection from the extension popup.</p>}
        {id&&!loaded&&<p>Checking your account…</p>}
        {id&&loaded&&!state.user&&<ExtensionSignIn key={id} id={id} onError={setError}/>}
        {id&&loaded&&state.user&&attempt&&<>
          <p style={{margin:'24px 0'}}>Connect as <strong>{attempt.user.name}</strong></p>
          <code style={{fontSize:11,overflowWrap:'anywhere'}}>{attempt.extensionOrigin}</code>
          <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:24}}>
            <button className="button" disabled={approving||busy} onClick={()=>void approve()}>Connect this extension</button>
            <button className="button" disabled={approving||busy} onClick={()=>{setError('');void logout();}}>Use a different account</button>
          </div>
        </>}
      </>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
