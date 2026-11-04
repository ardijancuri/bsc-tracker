import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {ensureAuthSchema,resolveAuthUser} from './telegramAuth.js';
import {ensureExtensionSchema,registerExtensionApi} from './extensionApi.js';
import {defaultExtensionPreferences} from '../shared/extension.js';
import type {ExtensionSocialProvider} from './extensionSocial.js';
const source=new URL(process.env.EXTENSION_DATABASE_URL??'postgresql://postgres@127.0.0.1:5442/kollens_extension_local_20261102');
if(source.hostname!=='127.0.0.1'||source.port!=='5442'||!source.pathname.startsWith('/kollens_extension_'))throw Error('Use only an isolated extension database on 127.0.0.1:5442');
const db=new Pool({connectionString:source.href,max:8}),origin='https://kollens.example',extension='chrome-extension://'+'a'.repeat(32);
let clock=Date.now();const users=[randomUUID(),randomUUID()],webSecrets=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex'),verifier=randomBytes(32).toString('hex'),challenge=createHash('sha256').update(verifier).digest('base64url');
let socialSubject = String(randomBytes(4).readUInt32BE() + 1);
const provider:ExtensionSocialProvider={
 async authorizationUrl({callback,state,nonce,verifier}){
  assert.ok(callback.startsWith(origin+'/api/auth/extension-social/'));
  assert.ok(nonce && verifier);
  return new URL('https://provider.example/authorize?'+new URLSearchParams({state}));
 },
 async identity({callbackUrl,state}){
  assert.equal(callbackUrl.searchParams.get('state'),state);
  assert.equal(callbackUrl.searchParams.get('code'),'verified');
  return {subject:socialSubject,username:'verified_handle'};
 },
};
const app=Fastify();registerExtensionApi(app,{db,origin,extensionOrigins:[extension],now:()=>clock,socialProviders:{x:provider,telegram:provider}});
const web=(n=0)=>({origin,cookie:`bscan_auth=${webSecrets[n]}`});
const call=async(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={})=>await app.inject({method,url,headers,payload:payload as any});
const status=async(code:number,promise:ReturnType<typeof call>)=>{const r=await promise;assert.equal(r.statusCode,code,r.body);return r.json();};
let assertions=0;
try{
 await ensureAuthSchema(db);await ensureExtensionSchema(db);
 assert.equal((await db.query("SELECT to_regclass('fresh.financial_events') AS financial")).rows[0].financial,null);assertions++;
 for(let n=0;n<2;n++){
  await db.query(`INSERT INTO auth_users(id,issuer,subject,name,preferences) VALUES($1::uuid,'extension-test',$1::text,$2,'{"notificationLanguage":"zh-CN"}')`,[users[n],`Integration ${n}`]);
  await db.query('INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES($1,$2,$3,$4)',[randomUUID(),users[n],hash(webSecrets[n]),new Date(clock+86400_000)]);
 }
 const start=await status(200,call('POST','/api/extension/auth/start',{challenge},{origin:extension}));assertions++;
 assert.equal((await status(202,call('POST','/api/extension/auth/exchange',{id:start.id,verifier},{origin:extension}))).pending,true);assertions++;
 await status(401,call('POST','/api/extension/auth/exchange',{id:start.id,verifier:'x'.repeat(64)},{origin:extension}));assertions++;
 await status(401,call('POST','/api/extension/auth/approve',{id:start.id,expectedUserId:users[0]},{origin}));assertions++;
 await status(403,call('POST','/api/extension/auth/approve',{id:start.id,expectedUserId:users[0]},{...web(),origin:'https://evil.example'}));assertions++;
 await status(409,call('POST','/api/extension/auth/approve',{id:start.id,expectedUserId:users[1]},web()));assertions++;
 await status(200,call('POST','/api/extension/auth/approve',{id:start.id,expectedUserId:users[0]},web()));assertions++;
 const exchange=await Promise.all([call('POST','/api/extension/auth/exchange',{id:start.id,verifier},{origin:extension}),call('POST','/api/extension/auth/exchange',{id:start.id,verifier},{origin:extension})]);
 assert.deepEqual(exchange.map(r=>r.statusCode).sort(),[200,410]);assertions++;
 const token=exchange.find(r=>r.statusCode===200)!.json().token,headers={origin:extension,authorization:`Bearer ${token}`};
 const initial=await status(200,call('GET','/api/extension/workspace',undefined,headers));assert.equal(initial.user.id,users[0]);assert.equal(initial.items.length,0);assertions++;
 await status(403,call('GET','/api/extension/workspace',undefined,{...headers,origin:'https://evil.example'}));assertions++;
 await status(200,call('GET','/api/extension/workspace',undefined,{authorization:headers.authorization,'x-kollens-extension-origin':extension}));assertions++;
 await status(401,call('GET','/api/extension/workspace',undefined,{'x-kollens-extension-origin':extension}));assertions++;
 await status(403,call('GET','/api/extension/workspace',undefined,{...headers,'x-kollens-extension-origin':'chrome-extension://'+'b'.repeat(32)}));assertions++;
 await status(401,call('GET','/api/extension/workspace',undefined,{origin:extension,cookie:web().cookie}));assertions++;
 assert.equal(await resolveAuthUser({headers:{cookie:`bscan_auth=${token}`}}as any,db),null);assertions++;
 const fakeHex=randomBytes(32).toString('hex');await db.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at,purpose) VALUES($1,$2,$3,$4,'extension')`,[randomUUID(),users[0],hash(fakeHex),new Date(clock+86400_000)]);
 assert.equal(await resolveAuthUser({headers:{cookie:`bscan_auth=${fakeHex}`}}as any,db),null);assertions++;
 const address='0x'+'1'.repeat(40),body={chainId:56,name:'Not in trading DB',symbol:'NEW',logoUrl:'https://cdn.gmgn.ai/token/photo.webp',pinned:true,note:'Private A note',revision:0};
 let first=await status(200,call('PUT',`/api/extension/tokens/${address}`,body,headers));assert.equal(first.items[0].note,body.note);assert.equal(first.items[0].logoUrl,body.logoUrl);assertions++;
 first=await status(200,call('PUT',`/api/extension/tokens/${address}`,{...body,logoUrl:undefined,revision:first.items[0].revision},headers));assert.equal(first.items[0].logoUrl,body.logoUrl);assertions++;
 for(const logoUrl of ['javascript:alert(1)','data:image/svg+xml,<svg/>','https://127.0.0.1/private','https://user:password@example.org/photo.png']){await status(400,call('PUT',`/api/extension/tokens/${address}`,{...body,logoUrl,revision:first.items[0].revision},headers));assertions++;}
 await status(400,call('PUT',`/api/extension/tokens/${address}`,{...body,note:'x'.repeat(2001)},headers));assertions++;
 const stale=await status(409,call('PUT',`/api/extension/tokens/${address}`,{...body,note:'Stale note'},headers));assert.equal(stale.workspace.items[0].note,body.note);assertions++;
 const firstRevision=first.items[0].revision;
 await status(200,call('DELETE',`/api/extension/tokens/${address}`,{revision:firstRevision},headers));
 const recreated=await status(200,call('PUT',`/api/extension/tokens/${address}`,body,headers));assert.ok(recreated.items[0].revision>firstRevision);assertions++;
 await status(409,call('PUT',`/api/extension/tokens/${address}`,{...body,revision:firstRevision},headers));assertions++;
 const pref=await status(200,call('PUT','/api/extension/preferences',{preferences:{...defaultExtensionPreferences,sound:true},revision:0},headers));assert.equal(pref.preferences.sound,true);assertions++;
 await status(409,call('PUT','/api/extension/preferences',{preferences:defaultExtensionPreferences,revision:0},headers));assertions++;
 assert.equal((await db.query('SELECT preferences FROM auth_users WHERE id=$1',[users[0]])).rows[0].preferences.notificationLanguage,'zh-CN');assertions++;
 const parallel=await Promise.all(Array.from({length:100},(_,i)=>call('PUT',`/api/extension/tokens/0x${(i+100).toString(16).padStart(40,'0')}`,body,headers)));
 assert.equal(parallel.filter(r=>r.statusCode===200).length,99);assert.equal(parallel.filter(r=>r.statusCode===409).length,1);assertions++;
 const other=await status(200,call('POST','/api/extension/auth/start',{challenge},{origin:extension}));
 await status(200,call('POST','/api/extension/auth/approve',{id:other.id,expectedUserId:users[1]},web(1)));
 const otherToken=(await status(200,call('POST','/api/extension/auth/exchange',{id:other.id,verifier},{origin:extension}))).token;
 const otherHeaders={origin:extension,authorization:`Bearer ${otherToken}`};
 const isolated=await status(200,call('GET','/api/extension/workspace',undefined,otherHeaders));assert.equal(isolated.items.length,0);assert.equal(isolated.user.id,users[1]);assertions++;
 const native=await status(200,call('POST','/api/extension/auth/start',{challenge,mode:'native'},{origin:extension}));
 assert.equal(native.url,undefined);
 await status(410,call('GET','/api/extension/auth/attempt/'+native.id,undefined,web()));
 await status(410,call('POST','/api/extension/auth/approve',{id:native.id,expectedUserId:users[0]},web()));assertions+=3;

 const authOptions=await status(200,call('GET','/api/extension/auth/options',undefined,{origin:extension}));
 assert.deepEqual(authOptions,{google:false,email:false,telegram:true,x:true});assertions++;
 await db.query('UPDATE auth_users SET email=$2 WHERE id=$1',[users[0],'verified@example.test']);
 const socialStart=(name:string,clientHeaders:Record<string,string>)=>call('POST','/api/extension/auth/social/'+name+'/start',{},clientHeaders);
 const finish=(name:string,result:Record<string,string>,clientHeaders:Record<string,string>)=>call('POST','/api/extension/auth/social/'+name+'/finish',result,clientHeaders);
 const stageSocial=async(name:string,clientHeaders:Record<string,string>)=>{
  const started=await status(200,socialStart(name,clientHeaders));
  const launchUrl=new URL(started.url);
  assert.equal(launchUrl.origin,origin);
  const path=launchUrl.pathname+launchUrl.search;
  const launch=await call('GET',path);assert.equal(launch.statusCode,302);
  assert.equal(new URL(launch.headers.location as string).origin,'https://provider.example');
  await status(410,call('GET',path));
  const callback='/api/auth/extension-social/'+name+'/callback?'+new URLSearchParams({state:started.state,code:'verified'});
  await status(410,call('GET',callback));
  const cookies=String(launch.headers['set-cookie']).split(';')[0];
  const result=await call('GET',callback,undefined,{cookie:cookies});assert.equal(result.statusCode,302);
  assert.doesNotMatch(String(result.headers['set-cookie']),/bscan_auth/);
  const returned=new URL(result.headers.location as string);
  assert.equal(returned.origin,'https://'+'a'.repeat(32)+'.chromiumapp.org');
  const proof=Object.fromEntries(new URLSearchParams(returned.hash.slice(1)));
  assert.equal(proof.state,started.state);
  return proof;
 };
 await status(401,socialStart('x',{origin:extension,cookie:web().cookie}));assertions++;
 const pendingLink=await stageSocial('x',headers);
 await status(410,finish('x',pendingLink,otherHeaders));
 await status(410,finish('x',{...pendingLink,proof:'0'.repeat(64)},headers));
 await status(200,finish('x',pendingLink,headers));
 await status(410,finish('x',pendingLink,headers));assertions+=4;
 const linked=await status(200,call('GET','/api/extension/workspace',undefined,headers));
 assert.equal(linked.user.email,'verified@example.test');assert.equal(linked.user.xUsername,'verified_handle');
 const unlinked=await status(200,call('GET','/api/extension/workspace',undefined,otherHeaders));
 assert.equal(unlinked.user.email,null);assert.equal(unlinked.user.xUsername,null);assertions+=4;
 await status(409,finish('x',await stageSocial('x',otherHeaders),otherHeaders));assertions++;
 await status(200,finish('telegram',await stageSocial('telegram',headers),headers));
 const telegram=await status(200,call('GET','/api/extension/workspace',undefined,headers));
 assert.equal(telegram.user.telegramLinked,true);assert.equal(telegram.user.telegramUsername,'verified_handle');
 assert.equal((await db.query('SELECT telegram_id FROM auth_users WHERE id=$1',[users[0]])).rows[0].telegram_id,null);assertions+=4;
 socialSubject=String(Number(socialSubject)+1);
 const revokedLink=await stageSocial('telegram',headers);
 await status(200,call('POST','/api/extension/auth/revoke',{},headers));await status(401,call('GET','/api/extension/workspace',undefined,headers));assertions++;
 await status(401,finish('telegram',revokedLink,headers));assertions++;
 await status(200,call('GET','/api/extension/workspace',undefined,otherHeaders));assert.ok(await resolveAuthUser({headers:web()}as any,db));assertions++;
 const expiring=await status(200,call('POST','/api/extension/auth/start',{challenge},{origin:extension}));clock+=600001;
 await status(410,call('POST','/api/extension/auth/exchange',{id:expiring.id,verifier},{origin:extension}));assertions++;
 assert.equal((await db.query("SELECT to_regclass('fresh.financial_events') AS financial")).rows[0].financial,null);assertions++;
 console.log(JSON.stringify({ok:true,assertions,concurrentSaves:100,financialTablesCreated:0,realMessages:0,database:source.pathname.slice(1)}));
}finally{
 await db.query('DELETE FROM auth_login_attempts WHERE expected_user_id=ANY($1::uuid[])',[users]);
 await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])',[users]);
 await app.close();await db.end();
}
