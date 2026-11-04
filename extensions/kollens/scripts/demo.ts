import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {Pool} from 'pg';
import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {ensureAuthSchema} from '../../../server/telegramAuth.js';
import {ensureExtensionSchema,registerExtensionApi} from '../../../server/extensionApi.js';
import {WorkspaceSync,type LocalStore} from '../src/sync';

const connection=process.env.EXTENSION_DATABASE_URL??'postgresql://postgres@127.0.0.1:5442/kollens_extension_local_20261102';
const source=new URL(connection);
if(source.hostname!=='127.0.0.1'||source.port!=='5442'||!/^\/kollens_extension_/.test(source.pathname))throw Error('Use only the task-owned extension database on 127.0.0.1:5442');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),origin='http://127.0.0.1:3360';
const db=new Pool({connectionString:connection,max:6});await ensureAuthSchema(db);await ensureExtensionSchema(db);
const demoUsers=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
for(let i=0;i<2;i++)await db.query(`INSERT INTO auth_users(id,issuer,subject,name) VALUES($1,'extension-demo',$2,$3) ON CONFLICT(id) DO NOTHING`,[demoUsers[i],String(i),`Local demo ${i?'B':'A'}`]);
const app=Fastify({logger:false});
const developmentKey=JSON.parse(await readFile(resolve(root,'development-key.json'),'utf8')).publicKey;
const extensionId=[...createHash('sha256').update(Buffer.from(developmentKey,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
registerExtensionApi(app,{db,origin,extensionOrigins:[origin,`chrome-extension://${extensionId}`,...(process.env.KOLLENS_EXTENSION_ORIGINS??'').split(',').filter(Boolean)]});
const clients=new Map<string,WorkspaceSync>();
app.post('/__demo/message',async(req,reply)=>{
  if(req.headers.origin!==origin)return reply.code(403).send({error:'Demo origin rejected'});
  const clientId=req.headers['x-demo-client'];if(typeof clientId!=='string'||!/^[a-f0-9-]{36}$/.test(clientId))return reply.code(400).send({error:'Invalid preview session'});
  let client=clients.get(clientId);
  if(!client){if(clients.size>=50)return reply.code(429).send({error:'Too many demo sessions'});const memory=new Map();const store:LocalStore={async get(key){return structuredClone(memory.get(key));},async set(key,value){memory.set(key,structuredClone(value));}};
    const fetcher:typeof fetch=(input,init)=>fetch(input,{...init,headers:{...init?.headers,Origin:origin}});client=new WorkspaceSync(origin,store,fetcher);clients.set(clientId,client);}
  const message=req.body as any;
  try{
    if(message.ownerId!==undefined&&message.ownerId!==(await client.state()).ownerId)throw new Error('Account changed');
    switch(message.kind){
      case 'state':await client.sync();return{...await client.state(),...await client.settings(),gmgnAuthorized:false,demoAccount:true,authOptions:{google:false,email:false}};
      case 'connect':{let url='';await client.connect(async value=>{url=value;});return{ok:true,url};}
      case 'disconnect':await client.disconnect();break;
      case 'cancel-pairing':await client.cancelPairing();return{ok:true};
      case 'edit':await client.edit(message.item,message.action??'save');break;
      case 'resolve':await client.resolve(message.address,message.choice);break;
      case 'preferences':await client.preferences(message.preferences,message.activateSound===true);break;
      case 'resolvePreferences':await client.resolvePreferences(message.choice);break;
      case 'ui':await client.rememberUi(message.ownerId,message.patch);return{ok:true};
      case 'select':return{ok:true};
      default:return reply.code(400).send({error:'Unsupported preview request'});
    }
    await client.sync();return{ok:true};
  }catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'Preview request failed'});}
});
app.post('/__demo/login',async(req,reply)=>{
  if(req.headers.origin!==origin)return reply.code(403).send({error:'Demo origin rejected'});
  const user=(req.body as any)?.account==='B'?demoUsers[1]:demoUsers[0],token=randomBytes(32).toString('hex');
  await db.query(`INSERT INTO auth_sessions(id,user_id,secret_hash,expires_at) VALUES(gen_random_uuid(),$1,$2,now()+interval '1 day')`,[user,createHash('sha256').update(token).digest('hex')]);
  return reply.header('Set-Cookie',`bscan_auth=${token}; Path=/; HttpOnly; SameSite=Lax`).send({ok:true});
});
app.get('/extension/connect',async(_req,reply)=>reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Connect local extension</title><style>body{max-width:540px;margin:90px auto;background:#0c1112;color:#e7eeee;font:15px system-ui;line-height:1.8}button{background:#edca30;border:0;border-radius:6px;padding:12px 17px;margin:8px 8px 8px 0;color:#171b15;font-weight:700}p{color:#97abad}code{font-size:11px}</style></head><body><h1>Connect local Kollens demo</h1><p>Test accounts only. No real Telegram login, messages or production account changes.</p><button id="login-a">Use test account A</button><button id="login-b">Use test account B</button><p id="status"></p><button id="approve" disabled>Connect this extension</button><button id="revoke">Disconnect all extension sessions for this test account</button><script src="/connect-demo.js"></script></body></html>`));
app.get('/connect-demo.js',async(_req,reply)=>reply.type('application/javascript').send(`let user=null;const id=new URLSearchParams(location.search).get('id'),status=document.querySelector('#status');async function load(){if(!id){status.textContent='Start connection from the extension panel.';return;}const r=await fetch('/api/extension/auth/attempt/'+id),v=await r.json();if(r.ok){user=v.user;status.textContent='Connect as '+user.name+' · '+v.extensionOrigin;document.querySelector('#approve').disabled=false;}else status.textContent=v.error;}for(const a of ['a','b'])document.querySelector('#login-'+a).onclick=async()=>{await fetch('/__demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:a.toUpperCase()})});await load();};document.querySelector('#approve').onclick=async()=>{const r=await fetch('/api/extension/auth/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,expectedUserId:user.id})});const v=await r.json();status.textContent=r.ok?'Connected. Return to the extension.':v.error;document.querySelector('#approve').disabled=true;};document.querySelector('#revoke').onclick=async()=>{const r=await fetch('/api/extension/auth/revoke-all',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});status.textContent=r.ok?'All extension sessions for this test account were revoked.':'Sign in to a test account first.';};void load();`));
app.get('/fixture',async(_req,reply)=>reply.type('text/html').send(await readFile(resolve(root,'fixture.html'),'utf8')));
app.get('/',async(_req,reply)=>reply.redirect('/fixture'));
await app.register(fastifyStatic,{root:resolve(root,'dist-local'),prefix:'/'});
app.addHook('onClose',()=>db.end());
await app.listen({host:'127.0.0.1',port:3360});console.log('Extension demo ready: http://127.0.0.1:3360/fixture (isolated test accounts only)');
for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>void app.close());
