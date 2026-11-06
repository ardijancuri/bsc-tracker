import{describe,it,expect,vi}from'vitest';
import{WorkspaceSync,type LocalStore}from'./sync';
import{defaultExtensionPreferences,type ExtensionWorkspace}from'../../../shared/extension';
const address='0x'+'a'.repeat(40),identity={chainId:56 as const,address,name:'Test',symbol:'TEST',pinned:true,note:'My local note'};
function setup(){
 const memory=new Map<string,any>();const store:LocalStore={async get(key){return structuredClone(memory.get(key));},async set(key,value){memory.set(key,structuredClone(value));}};
 const workspace:ExtensionWorkspace={user:{id:'A',name:'Account A'},items:[],preferences:{...defaultExtensionPreferences},preferencesRevision:0};
 const sent:{url:string;body:any;auth:string|null}[]=[];let mode='ready';let revision=0;
 memory.set('auth',{token:'tokenA',userId:'A',expiresAt:new Date(Date.now()+86400000).toISOString()});
 const fetcher=async(input:any,init:any)=>{
  if(mode==='offline')throw Error('offline');const url=String(input),body=init.body?JSON.parse(init.body):null,auth=new Headers(init.headers).get('Authorization');sent.push({url,body,auth});
  if(url.endsWith('/workspace'))return Response.json(workspace,{status:mode==='revoked'?401:200});
  if(url.includes('/tokens/')){
   if(mode==='conflict')return Response.json({workspace,error:'Conflict'},{status:409});
   if(init.method==='DELETE')workspace.items=[];
   else workspace.items=[{...body,address,updatedAt:new Date().toISOString(),revision:++revision}];
   return Response.json(workspace);
  }
  return Response.json({disconnected:true});
 };
 const sync=new WorkspaceSync('https://kollens.test',store,fetcher as typeof fetch);
 return{sync,store,memory,sent,workspace,mode:(value:string)=>{mode=value;}};
}
describe('account-bound workspace synchronization',()=>{
 it('keeps explicitly saved thumbnail identity through offline edits and worker restart',async()=>{
  const t=setup(),logoUrl='https://cdn.gmgn.ai/token/photo.webp';await t.sync.refresh(true);await t.sync.edit({...identity,logoUrl});
  t.mode('offline');await t.sync.sync();const restarted=new WorkspaceSync('https://kollens.test',t.store);expect((await restarted.state()).drafts[0].item?.logoUrl).toBe(logoUrl);
  t.mode('ready');await t.sync.sync();expect((await t.sync.state()).workspace?.items[0].logoUrl).toBe(logoUrl);expect(t.sent.find(s=>s.url.includes('/tokens/'))?.body.logoUrl).toBe(logoUrl);
 });
 it('queues offline edits and syncs later without losing text',async()=>{
  const t=setup();await t.sync.refresh(true);await t.sync.edit(identity);t.mode('offline');await t.sync.sync();expect((await t.sync.state()).drafts[0].item?.note).toBe(identity.note);
  t.mode('ready');await t.sync.sync();expect((await t.sync.state()).drafts).toHaveLength(0);expect((await t.sync.state()).workspace?.items[0].note).toBe(identity.note);
 });
 it('preserves queued notes and favorite status when edited independently',async()=>{
  const t=setup();
  await t.sync.refresh(true);
  await t.sync.edit(identity);
  await t.sync.edit({...identity,note:'Outdated panel note',pinned:false},'save','pinned');
  expect((await t.sync.state()).drafts[0].item).toMatchObject({note:identity.note,pinned:false});
  await t.sync.edit({...identity,note:'Updated note'},'save','note');
  await t.sync.sync();
  expect((await t.sync.state()).workspace?.items[0]).toMatchObject({note:'Updated note',pinned:false});
 });
 it('preserves a conflicting note until an explicit resolution',async()=>{
  const t=setup();await t.sync.refresh(true);await t.sync.edit(identity);t.mode('conflict');await t.sync.sync();expect((await t.sync.state()).drafts[0]).toMatchObject({conflict:true,item:{note:identity.note}});
  const sent=t.sent.length;await t.sync.sync();expect(t.sent.length).toBe(sent);
  await t.sync.resolve(address,'mine');t.mode('ready');await t.sync.sync();expect((await t.sync.state()).drafts).toHaveLength(0);
 });
 it('never sends account A drafts using account B credentials',async()=>{
  const t=setup();await t.sync.refresh(true);await t.sync.edit(identity);
  t.workspace.user={id:'B',name:'Account B'};await t.store.set('auth',{token:'tokenB',userId:'B',expiresAt:new Date(Date.now()+86400000).toISOString()});
  await t.sync.refresh(true);await t.sync.sync();expect((await t.sync.state()).drafts).toHaveLength(0);expect(t.sent.filter(s=>s.url.includes('/tokens/'))).toHaveLength(0);
  expect((t.memory.get('account:A')as any).drafts[0].item.note).toBe(identity.note);
 });
 it('can discard an unsynced creation without sending an invalid delete',async()=>{
  const t=setup();await t.sync.refresh(true);await t.sync.edit(identity);await t.sync.edit(identity,'delete');await t.sync.sync();expect(t.sent.filter(s=>s.url.includes('/tokens/'))).toHaveLength(0);
 });
 it('a revoked session stops writes while preserving its drafts',async()=>{
  const t=setup();await t.sync.refresh(true);await t.sync.edit(identity);t.mode('revoked');await t.sync.refresh(true);await t.sync.sync();expect((await t.sync.state()).connected).toBe(false);expect((await t.sync.state()).drafts).toHaveLength(1);
 });
 it('does not expose pairing verifiers in panel state',async()=>{
  const t=setup();const expiresAt=new Date(Date.now()+60_000).toISOString();
  await t.store.set('pairing',{id:'id',expiresAt,method:'google',verifier:'private',proof:'private'});
  expect((await t.sync.state()).pending).toEqual({id:'id',expiresAt,method:'google',email:undefined});
 });
 it('keeps queued drafts across a new service worker instance',async()=>{
  const t=setup();await t.sync.refresh(true);await t.sync.edit(identity);const restarted=new WorkspaceSync('https://kollens.test',t.store);expect((await restarted.state()).drafts[0].item?.note).toBe(identity.note);
 });
 it('uses a global fetch receiver in the real browser transport',async()=>{
  const t=setup();
  vi.stubGlobal('fetch',function(this:unknown){expect(this).toBe(globalThis);return Promise.resolve(Response.json(t.workspace));});
  try{const client=new WorkspaceSync('https://kollens.test',t.store);await client.refresh(true);expect((await client.state()).workspace?.user.id).toBe('A');}finally{vi.unstubAllGlobals();}
 });
 it('a synced sound preference does not activate another browser',async()=>{
  const t=setup();t.workspace.preferences.sound=true;await t.sync.refresh(true);expect((await t.sync.settings()).soundActivated).toBe(false);
  await t.sync.preferences(t.workspace.preferences,true);expect((await t.sync.settings()).soundActivated).toBe(true);
 });
 it('an old refresh cannot resurrect a disconnected account',async()=>{
  const t=setup();let release!:(response:Response)=>void;
  const client=new WorkspaceSync('https://kollens.test',t.store,((input:any)=>String(input).endsWith('/workspace')?new Promise<Response>(r=>{release=r;}):Promise.resolve(Response.json({disconnected:true})))as typeof fetch);
  const pending=client.refresh(true);while(!release)await Promise.resolve();await client.disconnect();release(Response.json(t.workspace));await pending;
  expect((await client.state()).connected).toBe(false);expect(await t.store.get('auth')).toBeNull();
 });
 it('retains the popup view and unsaved note when the popup closes',async()=>{
  const t=setup();await t.sync.refresh(true);const editor={identity:{chainId:56 as const,address,name:'Token',symbol:'T'},text:'Unsaved private note',dirty:true};
  await t.sync.rememberUi('A',{view:'saved',editor});const reopened=new WorkspaceSync('https://kollens.test',t.store);
  expect((await reopened.state()).ui).toEqual({view:'saved',editor});expect(t.sent.filter(r=>r.url.includes('/tokens/'))).toHaveLength(0);
 });
 it('never restores or writes another account\'s popup note',async()=>{
  const t=setup();await t.sync.refresh(true);await t.sync.rememberUi('A',{editor:{identity:{chainId:56,address,name:'T',symbol:'T'},text:'Account A only',dirty:true}});
  await t.store.set('auth',{token:'tokenB',userId:'B',expiresAt:new Date(Date.now()+86400000).toISOString()});
  expect((await t.sync.state()).ui.editor).toBeNull();await expect(t.sync.rememberUi('A',{view:'saved'})).rejects.toThrow('Account changed');
 });
});

const origin='https://kollens.test', callback='https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/kollens';
const nativeProof='a'.repeat(64), expiresAt=()=>new Date(Date.now()+60_000).toISOString();
function nativeSetup(overrides: (path:string,body:any)=>Response|Promise<Response>|undefined = ()=>undefined) {
 const t=setup();t.memory.clear();
 const requests:{path:string;body:any}[]=[];
 const fetcher:typeof fetch=async (input,init)=>{
  const path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
  requests.push({path,body});expect(init?.credentials).toBe('omit');
  const override=await overrides(path,body);if(override)return override;
  if(path.endsWith('/auth/start'))return Response.json({id:'pairing-id',expiresAt:expiresAt()});
  if(path.endsWith('/google/start'))return Response.json({url:origin+'/api/auth/google/extension/launch?state=test'});
  if(path.endsWith('/email/start'))return Response.json({sent:true});
  if(path.endsWith('/email/verify'))return Response.json({verified:true,proof:nativeProof});
  if(path.endsWith('/auth/exchange'))return Response.json({token:'extension-only',expiresAt:expiresAt()});
  if(path.endsWith('/auth/revoke'))return Response.json({disconnected:true});
  if(path.endsWith('/workspace'))return Response.json(t.workspace);
  throw Error('Unexpected test request');
 };
 return {...t,requests,fetcher,client:new WorkspaceSync(origin,t.store,fetcher)};
}
describe('direct extension sign-in',()=>{
 it('opens only the expected Google launch and exchanges the paired verifier plus completion proof',async()=>{
  const t=nativeSetup();
  await t.client.googleConnect(async url=>{
   expect(url).toBe(origin+'/api/auth/google/extension/launch?state=test');
   expect((await t.client.state()).pending?.method).toBe('google');
   await t.client.sync();
   expect(t.requests.some(request=>request.path.endsWith('/auth/exchange'))).toBe(false);
   return callback+'#id=pairing-id&proof='+nativeProof;
  },callback);
  expect(t.requests[0].body.mode).toBe('native');
  expect(t.requests.find(request=>request.path.endsWith('/auth/exchange'))?.body)
   .toEqual({id:'pairing-id',verifier:t.requests[1].body.verifier,proof:nativeProof});
  expect((await t.client.state()).connected).toBe(true);
  expect((await t.client.state()).pending).toBeNull();
 });
 it.each([callback+'#id=wrong&proof='+nativeProof,callback+'#id=pairing-id&proof='+nativeProof+'&proof='+nativeProof,
  'https://example.org/kollens#id=pairing-id&proof='+nativeProof,callback+'#error=cancelled'])('rejects a foreign, ambiguous or cancelled result (%s)',async result=>{
  const t=nativeSetup();
  await expect(t.client.googleConnect(async()=>result,callback)).rejects.toThrow(/Google sign-in/);
  expect(t.requests.some(request=>request.path.endsWith('/auth/exchange'))).toBe(false);
  expect((await t.client.state()).pending).toBeNull();
 });
 it('restores an email code attempt after the popup or worker closes',async()=>{
  const t=nativeSetup(),email='test@example.org';
  await t.client.startEmail(email);
  const restarted=new WorkspaceSync(origin,t.store,t.fetcher);
  expect((await restarted.state()).pending).toMatchObject({method:'email',email});
  await expect(restarted.verifyEmail('different@example.org','012345')).rejects.toThrow('Request a new sign-in code.');
  await restarted.verifyEmail(email,'012345');
  const verification=t.requests.find(request=>request.path.endsWith('/email/verify'))!;
  expect(verification.body.verifier).toBe(t.requests.find(request=>request.path.endsWith('/email/start'))?.body.verifier);
  expect((await restarted.state()).connected).toBe(true);
 });
 it('revokes a late exchange instead of restoring a cancelled session',async()=>{
  let finish!:(response:Response)=>void;
  const t=nativeSetup(path=>path.endsWith('/auth/exchange')?new Promise<Response>(resolve=>{finish=resolve;}):undefined);
  const pending=t.client.googleConnect(async()=>callback+'#id=pairing-id&proof='+nativeProof,callback);
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  await t.client.cancelPairing();
  finish(Response.json({token:'late',expiresAt:expiresAt()}));
  await pending;
  expect(t.requests.some(request=>request.path.endsWith('/auth/revoke'))).toBe(true);
  expect((await t.client.state()).connected).toBe(false);
 });
 it('finishes a verified social link with the current extension session',async()=>{
  const t=setup(),state='b'.repeat(64);
  const fetcher:typeof fetch=vi.fn(async(input,init)=>{
   const url=new URL(String(input));
   expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tokenA');
   if(url.pathname.endsWith('/social/x/start'))return Response.json({url:origin+'/api/auth/extension-social/x/launch',state});
   if(url.pathname.endsWith('/social/x/finish')){
    expect(JSON.parse(String(init?.body))).toEqual({state,proof:nativeProof});
    return Response.json({linked:true});
   }
   expect(url.pathname).toBe('/api/extension/workspace');
   return Response.json({...t.workspace,user:{...t.workspace.user,xUsername:'verified'}});
  });
  const client=new WorkspaceSync(origin,t.store,fetcher);
  await client.linkSocial('x',async url=>{
   expect(url).toBe(origin+'/api/auth/extension-social/x/launch');
   return callback+'#state='+state+'&proof='+nativeProof;
  },callback);
  expect((await client.state()).workspace?.user.xUsername).toBe('verified');
  expect(fetcher).toHaveBeenCalledTimes(3);
 });
});
