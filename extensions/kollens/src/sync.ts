import { defaultExtensionPreferences, extensionAddress, type ExtensionWorkspace, type ExtensionTokenIdentity, type ExtensionPreferences } from '../../../shared/extension';

export interface LocalStore { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void> }
export interface Draft {
  id: string; userId: string; address: string; kind: 'save' | 'delete'; revision: number;
  item?: ExtensionTokenIdentity & { pinned: boolean; note: string }; conflict?: boolean; error?: string;
}
interface AccountState { workspace?: ExtensionWorkspace; drafts: Draft[]; preferenceDraft?: {preferences: ExtensionPreferences; revision: number; conflict?: boolean} }
interface Auth { token: string; expiresAt: string; userId?: string }
export interface PopupUi {view:'matches'|'saved'|'activity';editor:{identity:ExtensionTokenIdentity;text:string;dirty:boolean}|null}
export class WorkspaceSync {
  private syncing = false;
  private lastRefresh = 0;
  private currentEpoch = 0;
  private serial = Promise.resolve();
  constructor(private origin: string, private store: LocalStore, private fetcher: typeof fetch = (input,init)=>globalThis.fetch(input,init)) {}
  private async request(path: string, method = 'GET', body?: unknown, token?: string) {
    const response = await this.fetcher(this.origin + '/api/extension/' + path, { method, credentials: 'omit', cache: 'no-store',
      headers: { ...(typeof location!=='undefined'&&location.protocol==='chrome-extension:'?{'X-Kollens-Extension-Origin':location.origin}:{}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const value = await response.json(); return { status: response.status, value };
  }
  async auth() { return this.store.get<Auth>('auth'); }
  private async account(id: string): Promise<AccountState> { return await this.store.get<AccountState>(`account:${id}`) ?? { drafts: [] }; }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work); this.serial = next.then(() => {}, () => {}); return next;
  }
  async state() {
    const auth = await this.auth(), state = auth?.userId ? await this.account(auth.userId) : { drafts: [] } as AccountState;
    const pairing=await this.store.get<{id:string;expiresAt:string}>('pairing');
    return { connected: Boolean(auth?.token && auth.userId && Date.parse(auth.expiresAt) > Date.now()),
      workspace: state.workspace ?? null, drafts: state.drafts, preferenceDraft: state.preferenceDraft,
      ownerId:auth?.userId??'guest',ui:await this.store.get<PopupUi>(`popup:${auth?.userId??'guest'}`)??{view:'matches',editor:null},
      pending: pairing?{id:pairing.id,expiresAt:pairing.expiresAt}:null, error: await this.store.get<string>('syncError') };
  }
  async rememberUi(ownerId:string,patch:Partial<PopupUi>){
    if((await this.auth())?.userId!==ownerId&&!(ownerId==='guest'&&!(await this.auth())?.userId))throw Error('Account changed');
    if(patch.view!==undefined&&!['matches','saved','activity'].includes(patch.view))throw Error('Invalid view');
    const editor=patch.editor;
    if(editor&&(!extensionAddress(editor.identity.address)||editor.identity.chainId!==56||editor.text.length>2000||editor.identity.name.length>120||editor.identity.symbol.length>40))throw Error('Invalid note draft');
    await this.queue(async()=>{
      if(((await this.auth())?.userId??'guest')!==ownerId)throw Error('Account changed');
      const current=await this.store.get<PopupUi>(`popup:${ownerId}`)??{view:'matches',editor:null};
      await this.store.set(`popup:${ownerId}`,{...current,...patch});
    });
  }
  async connect(open: (url: string) => Promise<void>) {
    const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const result = await this.request('auth/start', 'POST', {challenge});
    if (result.status !== 200) throw new Error(result.value.error ?? 'Could not start connection');
    const url = new URL(result.value.url);
    if (url.origin !== this.origin || url.pathname !== '/extension/connect') throw new Error('Invalid connection destination');
    await this.store.set('pairing', {id:result.value.id,expiresAt:result.value.expiresAt,verifier});
    await open(url.href);
  }
  async advancePairing() {
    const epoch=this.currentEpoch;
    const pairing = await this.store.get<{id:string;expiresAt:string;verifier:string}>('pairing');
    if (!pairing) return;
    if (Date.parse(pairing.expiresAt) <= Date.now()) { await this.store.set('pairing', null); throw new Error('Connection expired. Connect again.'); }
    const result = await this.request('auth/exchange','POST',{id:pairing.id,verifier:pairing.verifier});
    if(epoch!==this.currentEpoch||(await this.store.get<{id:string}>('pairing'))?.id!==pairing.id){
      if(result.status===200)await this.request('auth/revoke','POST',{},result.value.token).catch(()=>{});
      return;
    }
    if (result.status === 202) return;
    await this.store.set('pairing', null);
    if (result.status !== 200) throw new Error(result.value.error ?? 'Connection failed');
    await this.queue(async()=>{if(epoch!==this.currentEpoch)return;this.currentEpoch++;await this.store.set('auth', {token:result.value.token,expiresAt:result.value.expiresAt});});
    this.lastRefresh = 0; await this.refresh(true);
  }
  async refresh(force = false) {
    if (!force && Date.now() - this.lastRefresh < 20_000) return;
    const auth = await this.auth(), epoch = this.currentEpoch; if (!auth?.token) return;
    const result = await this.request('workspace','GET',undefined,auth.token);
    if (epoch !== this.currentEpoch || (await this.auth())?.token !== auth.token) return;
    if (result.status === 401) { await this.store.set('auth',{...auth,token:''});await this.store.set('syncError','Disconnected. Local drafts are retained for this account.'); return; }
    if (result.status !== 200) throw new Error(result.value.error ?? 'Workspace unavailable');
    const workspace = result.value as ExtensionWorkspace;
    if (auth.userId && workspace.user.id !== auth.userId) throw new Error('Account identity changed');
    await this.queue(async () => {
      if(epoch!==this.currentEpoch||(await this.auth())?.token!==auth.token)return;
      const state = await this.account(workspace.user.id); state.workspace = workspace;
      await this.store.set(`account:${workspace.user.id}`,state);
      await this.store.set('auth',{...auth,userId:workspace.user.id});
    });
    await this.store.set('syncError',null); this.lastRefresh = Date.now();
  }
  async edit(item: ExtensionTokenIdentity & {pinned:boolean;note:string}, kind: 'save'|'delete' = 'save') {
    if (item.note.length > 2000) throw new Error('Notes are limited to 2,000 characters');
    const auth = await this.auth(); if (!auth?.userId || Date.parse(auth.expiresAt) <= Date.now()) throw new Error('Connect your Kollens account first');
    return this.queue(async () => {
      const state = await this.account(auth.userId!);
      if (!state.workspace) throw new Error('Load your workspace first');
      const previous = state.drafts.find(draft=>draft.address===item.address);
      if (previous?.conflict) throw new Error('Resolve this note conflict before saving again');
      const original = state.workspace.items.find(saved=>saved.address===item.address);
      if(kind==='delete'&&!original&&previous?.revision===0){state.drafts=state.drafts.filter(d=>d.address!==item.address);await this.store.set(`account:${auth.userId}`,state);return;}
      if (!original && !previous && state.workspace.items.length + state.drafts.filter(d=>d.revision===0).length >= 100) throw new Error('Save up to 100 tokens');
      const draft: Draft = {id:crypto.randomUUID(),userId:auth.userId!,address:item.address,kind,
        revision:previous?.revision ?? original?.revision ?? 0,item};
      state.drafts = [...state.drafts.filter(d=>d.address!==item.address),draft];
      await this.store.set(`account:${auth.userId}`,state);
    });
  }
  async resolve(address: string, choice: 'server'|'mine') {
    const auth = await this.auth(); if (!auth?.userId) throw new Error('Connect your Kollens account first');
    await this.queue(async () => {
      const state = await this.account(auth.userId!);
      const draft = state.drafts.find(d=>d.address===address); if (!draft || !state.workspace) return;
      if (choice==='server') state.drafts = state.drafts.filter(d=>d.address!==address);
      else { draft.revision=state.workspace.items.find(i=>i.address===address)?.revision??0; draft.conflict=false; draft.error=undefined; draft.id=crypto.randomUUID(); }
      await this.store.set(`account:${auth.userId}`,state);
    });
  }
  async preferences(preferences: ExtensionPreferences, activateSound=false) {
    const auth = await this.auth();
    if(activateSound||!preferences.sound)await this.store.set(`audioOptIn:${auth?.userId??'guest'}`,activateSound&&preferences.sound);
    if (!auth?.userId) { await this.store.set('guestPreferences',preferences); return; }
    await this.queue(async () => {
      const state = await this.account(auth.userId!); if (!state.workspace) throw new Error('Workspace unavailable');
      state.preferenceDraft = {preferences,revision:state.preferenceDraft?.revision??state.workspace.preferencesRevision};
      await this.store.set(`account:${auth.userId}`,state);
    });
  }
  async resolvePreferences(choice: 'server'|'mine') {
    const auth = await this.auth(); if (!auth?.userId) return;
    await this.queue(async () => {
      const state = await this.account(auth.userId!);
      if (choice==='server') state.preferenceDraft=undefined;
      else if (state.preferenceDraft && state.workspace) {state.preferenceDraft.revision=state.workspace.preferencesRevision;state.preferenceDraft.conflict=false;}
      await this.store.set(`account:${auth.userId}`,state);
    });
  }
  async settings() {
    const state = await this.state();
    const auth=await this.auth();
    return {preferences:state.preferenceDraft?.preferences??state.workspace?.preferences??await this.store.get<ExtensionPreferences>('guestPreferences')??{...defaultExtensionPreferences},
      soundActivated:Boolean(await this.store.get(`audioOptIn:${auth?.userId??'guest'}`)),
      saved:state.workspace?.items.filter(i=>i.pinned).map(i=>i.address)??[]};
  }
  async sync() {
    if (this.syncing) return; this.syncing=true;
    try {
      await this.advancePairing(); await this.refresh();
      const auth = await this.auth(), epoch = this.currentEpoch;
      if (!auth?.token || !auth.userId || Date.parse(auth.expiresAt)<=Date.now()) return;
      const snapshot = await this.account(auth.userId);
      for (const draft of snapshot.drafts.filter(d=>!d.conflict && !d.error)) {
        if ((await this.auth())?.token!==auth.token) return;
        const result = await this.request(`tokens/${draft.address}`,draft.kind==='delete'?'DELETE':'PUT',
          draft.kind==='delete'?{revision:draft.revision}:{...draft.item,revision:draft.revision,address:undefined},auth.token);
        if (epoch!==this.currentEpoch || (await this.auth())?.token!==auth.token) return;
        await this.queue(async () => {
          if(epoch!==this.currentEpoch||(await this.auth())?.token!==auth.token)return;
          const state = await this.account(auth.userId!); const current = state.drafts.find(d=>d.id===draft.id);
          if (result.status===200) {
            state.workspace=result.value;
            if (current) state.drafts=state.drafts.filter(d=>d.id!==draft.id);
            else {const newer=state.drafts.find(d=>d.address===draft.address);if(newer)newer.revision=result.value.items.find((i:any)=>i.address===draft.address)?.revision??0;}
          } else if (result.status===409 && result.value.workspace) {
            state.workspace=result.value.workspace;if(current) current.conflict=true;
          } else if ([400,404,413].includes(result.status) && current) current.error=result.value.error??'Could not save';
          await this.store.set(`account:${auth.userId}`,state);
        });
        if (result.status>=500 || result.status===401 || result.status===429) throw new Error(result.value.error??'Sync paused');
      }
      const pref = (await this.account(auth.userId)).preferenceDraft;
      if (pref && !pref.conflict) {
        const result=await this.request('preferences','PUT',{preferences:pref.preferences,revision:pref.revision},auth.token);
        if(epoch!==this.currentEpoch || (await this.auth())?.token!==auth.token)return;
        await this.queue(async()=>{
          if(epoch!==this.currentEpoch||(await this.auth())?.token!==auth.token)return;
          const state=await this.account(auth.userId!);
          if(result.status===200){state.workspace=result.value;if(JSON.stringify(state.preferenceDraft)===JSON.stringify(pref))state.preferenceDraft=undefined;else if(state.preferenceDraft)state.preferenceDraft.revision=result.value.preferencesRevision;}
          else if(result.status===409&&result.value.workspace){state.workspace=result.value.workspace;if(state.preferenceDraft)state.preferenceDraft.conflict=true;}
          else throw new Error(result.value.error??'Preferences unavailable');
          await this.store.set(`account:${auth.userId}`,state);
        });
      }
      await this.store.set('syncError',null);
    } catch { await this.store.set('syncError','Sync paused. Unsynced changes are kept on this browser.'); }
    finally {this.syncing=false;}
  }
  async disconnect() {
    const auth=await this.auth();
    this.currentEpoch++;
    // A failed revoke is explicit; do not claim remote revocation while offline.
    if(auth?.token){const result=await this.request('auth/revoke','POST',{},auth.token);if(![200,401].includes(result.status))throw new Error('Could not revoke this session. Try again online.');}
    await this.queue(async()=>{await this.store.set('auth',null);await this.store.set('pairing',null);});this.lastRefresh=0;
  }
}
