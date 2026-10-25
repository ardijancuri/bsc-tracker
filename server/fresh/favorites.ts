import { randomBytes,randomUUID } from 'node:crypto';
import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { resolveAuthUser,authSessionSecret } from '../telegramAuth.js';
import { hashSecret,sessionSecret,watchCookieName } from '../watchSessionSecrets.js';
import { tokenIdentity } from './reads.js';
import {freshPublicTokenSql} from './publicTokens.js';
import {watchPeriods,type WatchPeriod} from '../../shared/intelligence.js';

type Owner={id:string;kind:'account'|'guest'};
export function freshMutationAllowed(request:FastifyRequest,reply:FastifyReply) {
  const expected=new URL(process.env.PUBLIC_APP_URL??'https://kollens.com').origin;
  if(request.headers.origin!==expected){reply.code(403).send({error:'Request origin rejected'});return false;}return true;
}
export function registerFreshFavorites(app:FastifyInstance,db:Pool) {
  const table=(owner:Owner)=>owner.kind==='account'?'account_watch_entries':'watch_entries';
  const column=(owner:Owner)=>owner.kind==='account'?'user_id':'session_id';
  async function owner(request:FastifyRequest,reply:FastifyReply):Promise<Owner|null|undefined>{
    reply.header('Cache-Control','private,no-store').header('Vary','Cookie');
    const user=await resolveAuthUser(request,db),expected=request.headers['x-watchlist-owner'];
    if(expected!==undefined&&expected!==(user?.id??'guest')){reply.code(409).send({error:'Your account changed. Refresh and try again.'});return undefined;}
    if(user)return{id:user.id,kind:'account'};
    if(authSessionSecret(request.headers.cookie)){reply.code(401).send({error:'Your session expired. Log in again.'});return undefined;}
    const secret=sessionSecret(request.headers.cookie);if(!secret)return null;
    const row=(await db.query(`SELECT id FROM watch_sessions WHERE secret_hash=$1 AND expires_at>now()`,[hashSecret(secret)])).rows[0];
    return row?{id:row.id,kind:'guest'}:null;
  }
  async function read(selected:Owner|null,period:WatchPeriod='24h'){
    if(!selected)return{items:[],period};
    const rows=(await db.query(`SELECT e.kind,e.address,k.display_name,k.avatar_url,t.*,t.today_utc::text AS utc_date,
      e.address AS entity_address FROM ${table(selected)} e LEFT JOIN published_kols k ON e.kind='kol' AND k.address=e.address AND k.is_tracked
      LEFT JOIN fresh.tokens t ON e.kind='token' AND t.address=e.address AND ${freshPublicTokenSql()} WHERE e.${column(selected)}=$1 ORDER BY e.kind,e.address`,[selected.id])).rows;
    const history=new Map<string,{volume:string|null;kols:number}>();
    if(period!=='24h'){
      const addresses=rows.filter(row=>row.kind==='token'&&row.address).map(row=>row.address),since=new Date(Date.now()-(period==='7d'?7:30)*86_400_000);
      // Explicit older range selection aggregates compact trade facts once;
      // it never rebuilds accounting, scans the node or calls a provider.
      const totals=(await db.query(`SELECT e.token_address,count(DISTINCT e.wallet_address)::int AS kols,
        CASE WHEN count(*) FILTER(WHERE e.amount_usd IS NULL)>0 THEN NULL ELSE coalesce(sum(e.amount_usd::numeric),0)::text END AS volume
        FROM fresh.financial_events e JOIN fresh.kols k ON k.wallet_address=e.wallet_address AND k.is_tracked
        WHERE e.canonical AND e.kind IN('buy','sell') AND e.token_address=ANY($1::text[]) AND e.occurred_at>=$2
        AND e.block_number<=COALESCE((SELECT block_number FROM fresh.checkpoints WHERE key='capture'),0) GROUP BY e.token_address`,[addresses,since])).rows;
      for(const row of totals)history.set(row.token_address,row);
    }
    return{items:rows.map(r=>{
      if(r.kind==='kol')return{kind:'kol',address:r.entity_address,name:r.display_name,avatarUrl:r.avatar_url};
      const token=tokenIdentity({...r,address:r.entity_address}),past=history.get(r.entity_address);return{...token,kind:'token',periodVolumeUsd:period==='24h'?token.volume24hUsd:past?past.volume:'0',periodKolCount:period==='24h'?token.kolCount24h:past?.kols??0,priceHistory:[]};
    }),period};
  }
  app.get<{Querystring:{period?:string}}>('/api/watchlist',async(req,reply)=>{const who=await owner(req,reply);if(who===undefined)return;
    const period=req.query.period??'24h';if(!watchPeriods.includes(period as WatchPeriod))return reply.code(400).send({error:'Invalid watchlist range'});return read(who,period as WatchPeriod);});
  for(const method of ['PUT','DELETE'] as const)app.route<{Params:{kind:string;address:string}}>({method,url:'/api/watchlist/items/:kind/:address',handler:async(req,reply)=>{
    if(!freshMutationAllowed(req,reply))return;let who=await owner(req,reply);if(who===undefined)return;
    const{kind}=req.params,key=req.params.address.toLowerCase();if(!['kol','token'].includes(kind)||!/^0x[a-f0-9]{40}$/.test(key))return reply.code(400).send({error:'Invalid favorite'});
    const client=await db.connect();let secret:string|undefined;
    try{await client.query('BEGIN');
      if(!who){secret=randomBytes(32).toString('hex');who={id:randomUUID(),kind:'guest'};await client.query(`INSERT INTO watch_sessions(id,secret_hash,expires_at) VALUES($1,$2,now()+interval '1 year')`,[who.id,hashSecret(secret)]);}
      await client.query(`SELECT id FROM ${who.kind==='account'?'auth_users':'watch_sessions'} WHERE id=$1 FOR UPDATE`,[who.id]);
      if(method==='PUT'){
        const valid=await client.query(kind==='kol'?`SELECT 1 FROM fresh.kols WHERE wallet_address=$1 AND is_tracked`:`SELECT 1 FROM fresh.tokens t WHERE t.address=$1 AND ${freshPublicTokenSql()}`,[key]);
        if(!valid.rowCount){await client.query('ROLLBACK');return reply.code(404).send({error:'Favorite not found'});}
        const count=(await client.query(`SELECT count(*)::int AS count,bool_or(address=$3) AS present FROM ${table(who)} WHERE ${column(who)}=$1 AND kind=$2`,[who.id,kind,key])).rows[0];
        if(count.count>=100&&!count.present){await client.query('ROLLBACK');return reply.code(400).send({error:'Watch up to 100 KOLs and 100 tokens'});}
        await client.query(`INSERT INTO ${table(who)}(${column(who)},kind,address) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[who.id,kind,key]);
      }else await client.query(`DELETE FROM ${table(who)} WHERE ${column(who)}=$1 AND kind=$2 AND address=$3`,[who.id,kind,key]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    if(secret)reply.header('Set-Cookie',`${watchCookieName}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${process.env.NODE_ENV==='production'?'; Secure':''}`);
    return read(who);
  }});
  app.delete('/api/watchlist',async(req,reply)=>{if(!freshMutationAllowed(req,reply))return;const who=await owner(req,reply);if(who===undefined)return;
    if(who)await db.query(`DELETE FROM ${table(who)} WHERE ${column(who)}=$1`,[who.id]);return{items:[],period:'24h'};});
}
