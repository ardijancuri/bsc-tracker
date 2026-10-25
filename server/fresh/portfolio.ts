import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { JournalActivity, JournalPosition, JournalSummary, JournalTokenActivity, JournalWallets } from '../../shared/journal.js';
import type { ChartRange } from '../../shared/intelligence.js';
import { journalWalletLimit } from '../../shared/journal.js';
import { resolveAuthUser, telegramAuthConfig, type ResolvedAuthUser } from '../telegramAuth.js';
import { FreshRational, freshDecimal, rebuildFreshScopesAfterReorg,freshFeeExclusions } from './accounting.js';
import type { createFreshReads } from './reads.js';
import type { FreshReplay } from './replay.js';
import { FreshChartError,freshChartIntervals,freshChartPeriods,freshChartFrom,type FreshCharts,type FreshResolution } from './charts.js';
import {freshTrackedTokenSql} from './tracking.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=(v:string|Date)=>new Date(v).toISOString();
const q=FreshRational.parse;
export class FreshPortfolioError extends Error {constructor(message:string,readonly statusCode=400){super(message);}}
export function freshPortfolioAddress(value:unknown) {
  if(typeof value!=='string'||!/^0x[\da-f]{40}$/i.test(value)||/^0x0{40}$/i.test(value))throw new FreshPortfolioError('Invalid BNB wallet address');
  return value.toLowerCase();
}
export function freshPortfolioLabel(value:unknown) {
  if(typeof value!=='string'||value.length>60||/[\u0000-\u001f\u007f]/.test(value))throw new FreshPortfolioError('Use a private label of up to 60 characters');return value.trim();
}
export const freshPortfolioScope=(userId:string,wallet?:string)=>`portfolio:${userId}:${wallet??'combined'}`;
type Member={wallet_address:string;label:string;added_at:Date|string;activity_from:Date|string;revision:string;registration_block:string;registration_hash:string};
type Reads=ReturnType<typeof createFreshReads>;
const setIdentity=(members:Member[])=>digest(members.map(m=>[m.wallet_address,m.revision]).sort((a,b)=>a[0].localeCompare(b[0])));
const firstAt=(members:Member[])=>members.length?new Date(Math.min(...members.map(m=>Date.parse(iso(m.activity_from))))).toISOString():null;

export function createFreshPortfolio({db,reads,replay,now=Date.now,requestQuote}:{db:Pool;reads:Reads;replay:FreshReplay;now?:()=>number;requestQuote?:(token:string)=>Promise<void>}) {
  async function members(userId:string,selected?:string):Promise<Member[]> {
    const all=(await db.query('SELECT * FROM public.journal_wallets WHERE user_id=$1 ORDER BY added_at,wallet_address',[userId])).rows as Member[];
    if(selected&&selected!=='all'){const wallet=freshPortfolioAddress(selected),found=all.find(m=>m.wallet_address===wallet);if(!found)throw new FreshPortfolioError('Portfolio wallet not found',404);return [found];}return all;
  }
  async function authorize(userId:string,wallet:string,revision?:string){const member=(await members(userId,freshPortfolioAddress(wallet)))[0];if(revision&&member.revision!==revision)throw new FreshPortfolioError('Portfolio membership changed. Refresh and try again.',409);return member;}
  async function assertUnchanged(userId:string,selected:string|undefined,before:Member[]){if(setIdentity(await members(userId,selected))!==setIdentity(before))throw new FreshPortfolioError('Portfolio membership changed. Refresh and try again.',409);}
  async function list(userId:string):Promise<JournalWallets>{
    const rows=(await db.query(`SELECT m.*,p.display_name,p.avatar_url,(SELECT block_number FROM fresh.checkpoints WHERE key='decode') AS decoded,
      EXISTS(SELECT 1 FROM fresh.jobs j WHERE j.kind='registration_capture' AND j.reference=m.wallet_address AND j.state NOT IN('done','cancelled')) AS registration_pending
      FROM public.journal_wallets m LEFT JOIN published_kols p ON p.address=m.wallet_address AND p.is_tracked WHERE m.user_id=$1 ORDER BY m.added_at,m.wallet_address`,[userId])).rows;
    return {limit:journalWalletLimit,wallets:rows.map(row=>{const ready=!row.registration_pending&&row.decoded!==null&&BigInt(row.decoded)>=BigInt(row.registration_block);return {address:row.wallet_address,label:row.label,addedAt:iso(row.added_at),activityFrom:iso(row.activity_from),revision:row.revision,
      ...(row.display_name||row.avatar_url?{publicIdentity:{name:row.display_name??null,avatarUrl:row.avatar_url??null}}:{}),preparation:{status:ready?'ready':'pending',historyComplete:ready}};})};
  }
  async function transaction<T>(userId:string,work:(client:PoolClient)=>Promise<T>){const client=await db.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fresh-portfolio:${userId}`]);const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
  async function updateCombined(client:PoolClient,userId:string){
    const all=(await client.query('SELECT * FROM public.journal_wallets WHERE user_id=$1 ORDER BY wallet_address',[userId])).rows as Member[];
    const scope=freshPortfolioScope(userId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fresh-scope:${scope}`]);
    if(!all.length){await client.query('DELETE FROM fresh.open_lots WHERE scope_id=$1',[scope]);await client.query('DELETE FROM fresh.positions WHERE scope_id=$1',[scope]);await client.query('DELETE FROM fresh.scope_event_results WHERE scope_id=$1',[scope]);await client.query('DELETE FROM fresh.accounting_scopes WHERE id=$1',[scope]);return;}
    await client.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,account_id,starts_at,starts_block) VALUES($1,'portfolio_combined',$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET wallet_addresses=excluded.wallet_addresses,starts_at=excluded.starts_at,starts_block=excluded.starts_block,active=true`,
    [scope,all.map(m=>m.wallet_address),userId,firstAt(all),all.reduce((min,m)=>BigInt(m.registration_block)<BigInt(min)?m.registration_block:min,all[0].registration_block)]);
    // Membership edits are exceptional; rebuilding this one compact book is allowed.
    await rebuildFreshScopesAfterReorg(client,[scope],now());
  }
  async function add(userId:string,address:unknown,labelValue:unknown=''){
    const wallet=freshPortfolioAddress(address),label=freshPortfolioLabel(labelValue);
    await transaction(userId,async client=>{
      if((await client.query('SELECT 1 FROM public.journal_wallets WHERE user_id=$1 AND wallet_address=$2',[userId,wallet])).rowCount)return;
      const count=(await client.query('SELECT count(*)::int n FROM public.journal_wallets WHERE user_id=$1',[userId])).rows[0].n;if(count>=journalWalletLimit)throw new FreshPortfolioError('You can track up to three portfolio wallets',409);
      const checkpoint=(await client.query("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='capture' FOR UPDATE")).rows[0];
      if(!checkpoint?.block_number)throw new FreshPortfolioError('Tracking is starting. Try again shortly.',503);
      const start=(BigInt(checkpoint.block_number)+1n).toString(),at=new Date(now()).toISOString(),revision=randomUUID();
      await client.query(`INSERT INTO fresh.wallets(address,monitoring_from_block,registered_at) VALUES($1,$2,$3)
        ON CONFLICT(address) DO UPDATE SET active=true,monitoring_to_block=NULL,monitoring_from_block=least(fresh.wallets.monitoring_from_block,excluded.monitoring_from_block),revision=fresh.wallets.revision+1`,[wallet,start,at]);
      await client.query(`INSERT INTO public.journal_wallets(user_id,wallet_address,label,revision,registration_block,registration_hash,added_at,activity_from) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,[userId,wallet,label,revision,start,checkpoint.block_hash,at]);
      const scope=freshPortfolioScope(userId,wallet);
      await client.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,account_id,starts_at,starts_block) VALUES($1,'portfolio_wallet',$2,$3,$4,$5)
        ON CONFLICT(id) DO UPDATE SET starts_at=excluded.starts_at,starts_block=excluded.starts_block,active=true,revision=fresh.accounting_scopes.revision+1,correction_epoch=fresh.accounting_scopes.correction_epoch+1`,[scope,[wallet],userId,at,start]);
      await client.query("UPDATE fresh.checkpoints SET revision=revision+1,updated_at=clock_timestamp() WHERE key='capture'");
      await updateCombined(client,userId);
    });return list(userId);
  }
  async function updateLabel(userId:string,address:unknown,labelValue:unknown){const wallet=freshPortfolioAddress(address),label=freshPortfolioLabel(labelValue);if(!(await db.query('UPDATE public.journal_wallets SET label=$3 WHERE user_id=$1 AND wallet_address=$2 RETURNING wallet_address',[userId,wallet,label])).rowCount)throw new FreshPortfolioError('Portfolio wallet not found',404);return list(userId);}
  async function remove(userId:string,address:unknown){const wallet=freshPortfolioAddress(address);await transaction(userId,async client=>{
    await client.query("SELECT 1 FROM fresh.checkpoints WHERE key='capture' FOR UPDATE");
    const removed=await client.query('DELETE FROM public.journal_wallets WHERE user_id=$1 AND wallet_address=$2 RETURNING wallet_address',[userId,wallet]);if(!removed.rowCount)throw new FreshPortfolioError('Portfolio wallet not found',404);
    const scope=freshPortfolioScope(userId,wallet);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fresh-scope:${scope}`]);
    await client.query('DELETE FROM fresh.open_lots WHERE scope_id=$1',[scope]);await client.query('DELETE FROM fresh.positions WHERE scope_id=$1',[scope]);await client.query('DELETE FROM fresh.scope_event_results WHERE scope_id=$1',[scope]);await client.query('DELETE FROM fresh.accounting_scopes WHERE id=$1',[scope]);
    await client.query(`UPDATE fresh.wallets SET active=false,monitoring_to_block=(SELECT block_number FROM fresh.checkpoints WHERE key='capture'),revision=revision+1
      WHERE address=$1 AND NOT EXISTS(SELECT 1 FROM fresh.kols WHERE wallet_address=$1 AND is_tracked) AND NOT EXISTS(SELECT 1 FROM public.journal_wallets WHERE wallet_address=$1)`,[wallet]);
    await client.query("UPDATE fresh.checkpoints SET revision=revision+1,updated_at=clock_timestamp() WHERE key='capture'");await updateCombined(client,userId);
  });return list(userId);}
  async function summary(userId:string,selected?:string):Promise<JournalSummary>{
    const all=await members(userId,selected),scope=freshPortfolioScope(userId,selected&&selected!=='all'?all[0]?.wallet_address:undefined);
    const [rows,scopeRows,state,owners,registration]=await Promise.all([reads.positionRows(scope),db.query('SELECT * FROM fresh.accounting_scopes WHERE id=$1 AND active',[scope]),reads.state(),
      db.query(`SELECT p.token_address,s.wallet_addresses FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id WHERE s.active AND s.kind='portfolio_wallet' AND s.account_id=$1`,[userId]),
      db.query("SELECT 1 FROM fresh.jobs WHERE kind='registration_capture' AND reference=ANY($1::text[]) AND state NOT IN('done','cancelled') LIMIT 1",[all.map(m=>m.wallet_address)])]);
    const scopeRow=scopeRows.rows[0],positions:JournalPosition[]=rows.map(({r,summary:s,snapshot,endingReady,endingReasons})=>({token:{address:r.token_address,name:r.name,symbol:r.symbol,logoUrl:r.logo_data?`/api/token-image/${r.token_address}`:r.logo_url},wallets:all.filter(m=>owners.rows.some(owner=>owner.token_address===r.token_address&&owner.wallet_addresses.includes(m.wallet_address))).map(m=>m.wallet_address),status:snapshot.reasons.includes('balance_mismatch')?'unknown':s.quantity==='0'?'closed':'open',remainingTokenAmount:s.quantity,remainingCostBasisUsd:s.remainingCostUsd,valueUsd:s.valueUsd,investedUsd:s.investedUsd,soldUsd:s.soldUsd,realizedProfitUsd:s.realizedProfitUsd,estimatedProfitUsd:s.estimatedProfitUsd,roi:s.roi,feeInclusiveCapitalUsd:s.capitalUsd,feesUsd:s.feesUsd,complete:endingReady,reasons:endingReasons}));
    const pending=!!registration.rowCount||all.some(m=>state.decode?.block_number==null||BigInt(state.decode.block_number)<BigInt(m.registration_block))||positions.some(p=>p.reasons.some(r=>['balance_pending','decoding_pending','registration_pending'].includes(r)));
    const reasons=[...new Set(positions.flatMap(p=>p.reasons))];if(pending)reasons.push('collection_pending');if(Number(scopeRow?.fee_only_unknown_count??0)>0)reasons.push('unknown_fees');
    const complete=reasons.length===0;
    const total=(field:'valueUsd'|'investedUsd'|'soldUsd'|'realizedProfitUsd'|'estimatedProfitUsd'|'feeInclusiveCapitalUsd'|'feesUsd')=>positions.every(p=>p[field]!==null)?positions.reduce((sum,p)=>sum.add(q(p[field]!)),q('0')):null;
    const feeOnly=q(scopeRow?.fee_only_fees_q??'0'),failed=scopeRow?.fee_only_realized_q===null?null:q(scopeRow?.fee_only_realized_q??'0');
    const realized=total('realizedProfitUsd'),profit=total('estimatedProfitUsd'),capital=total('feeInclusiveCapitalUsd'),fees=total('feesUsd');
    const adjustedProfit=complete&&profit&&failed?profit.add(failed):null;
    await assertUnchanged(userId,selected,all);
    const asOf=rows.length?new Date(Math.min(...rows.map(row=>Date.parse(row.snapshot.asOf)))).toISOString():iso(state.decode?.updated_at??new Date(now()));
    return {version:1,snapshotId:digest([userId,setIdentity(all),scopeRow?.revision,rows.map(row=>row.snapshot.snapshotId),freshFeeExclusions(scopeRow)]),selectedWallets:all.map(m=>m.wallet_address),asOf,activityFrom:firstAt(all),coverage:'since_wallet_added',complete,preparing:pending,reasons,positions,exclusions:{feeOnly:freshFeeExclusions(scopeRow)},
      totals:{valueUsd:total('valueUsd')?.decimal()??null,investedUsd:total('investedUsd')?.decimal()??null,soldUsd:total('soldUsd')?.decimal()??null,
        realizedProfitUsd:realized&&failed?realized.add(failed).decimal():null,estimatedProfitUsd:adjustedProfit?.decimal()??null,
        roi:adjustedProfit&&capital&&capital.n>0n?adjustedProfit.div(capital).decimal():null,feeInclusiveCapitalUsd:capital?.decimal()??null,feesUsd:Number(scopeRow?.fee_only_unknown_count??0)>0?null:fees?.add(feeOnly).decimal()??null},...(pending?{retryAfterMs:2000}:{})};
  }
  async function activity(userId:string,selected?:string,cursor?:string):Promise<JournalActivity>{const all=await members(userId,selected),scope=freshPortfolioScope(userId,selected&&selected!=='all'?all[0]?.wallet_address:undefined),page=await reads.trades({scopeId:scope,cursor,limit:50});await assertUnchanged(userId,selected,all);return {trades:page.items.filter(t=>t.side==='buy'||t.side==='sell').map(t=>({id:t.id,walletAddress:t.walletAddress,tokenAddress:t.tokenAddress,tokenSymbol:t.tokenSymbol,tokenName:t.tokenName,tokenLogoUrl:t.tokenLogoUrl,side:t.side as 'buy'|'sell',tokenAmount:t.tokenAmount,amountUsd:t.amountUsd,quoteAmount:t.quoteAmount,quoteSymbol:t.quoteSymbol,quoteTokenAddress:t.quoteTokenAddress??null,bnbEquivalentAmount:t.bnbEquivalentAmount??null,txHash:t.txHash,timestamp:t.timestamp,source:'node'})),cursor:page.nextCursor,activityFrom:firstAt(all),preparing:false};}
  async function tokenActivity(userId:string,wallet:string,token:string,replayRequested=false,snapshot?:string):Promise<JournalTokenActivity|undefined>{
    wallet=freshPortfolioAddress(wallet);token=freshPortfolioAddress(token);const member=await authorize(userId,wallet),scope=freshPortfolioScope(userId,wallet),audience=`account:${userId}`;
    if(!snapshot&&requestQuote&&(await db.query('SELECT 1 FROM fresh.positions WHERE scope_id=$1 AND token_address=$2',[scope,token])).rowCount)await requestQuote(token);
    const value=snapshot?replay.saved(snapshot,audience):await reads.activity(wallet,token,scope,replayRequested);
    if(snapshot&&(!value||value.kol.address!==wallet||value.token.address!==token))throw new FreshPortfolioError('This saved replay has expired. Prepare the trade again.',409);
    if(!value)return undefined;
    const metadata=(value as JournalTokenActivity).journal;
    if(snapshot&&(!metadata||metadata.accountId!==userId||metadata.membershipRevision!==member.revision))throw new FreshPortfolioError('This saved replay changed. Prepare the trade again.',410);
    if(snapshot){const current=(await db.query('SELECT revision,correction_epoch FROM fresh.accounting_scopes WHERE id=$1 AND active AND account_id=$2',[scope,userId])).rows[0],pinned=(value as import('./replay.js').FreshReplayActivity).__freshRevision;
      if(!current||!pinned||pinned.scopeId!==scope||String(current.revision)!==String(pinned.membershipRevision)||String(current.correction_epoch)!==String(pinned.correctionEpoch))throw new FreshPortfolioError('This saved replay changed. Prepare the trade again.',410);}
    const response:JournalTokenActivity={...value,journal:{accountId:userId,walletAddress:wallet,membershipRevision:member.revision,preparedAt:value.generatedAt,private:true,snapshotId:value.accountingSnapshot?.snapshotId}};
    if(replayRequested)replay.remember(response,audience);await authorize(userId,wallet,member.revision);return response;
  }
  return {members,authorize,list,add,updateLabel,remove,summary,activity,tokenActivity};
}

export function registerFreshPortfolio(app:FastifyInstance,options:{db:Pool;reads:Reads;replay:FreshReplay;charts?:Pick<FreshCharts,'chart'>;requestQuote?:(token:string)=>Promise<void>;resolveUser?:(request:FastifyRequest)=>Promise<ResolvedAuthUser|null>;now?:()=>number}) {
  const service=createFreshPortfolio(options),resolve=options.resolveUser??((request:FastifyRequest)=>resolveAuthUser(request,options.db));
  const attempts=new Map<string,{until:number;count:number}>();
  async function account(request:FastifyRequest,reply:FastifyReply,mutation=false){reply.header('Cache-Control','private, no-store').header('Vary','Cookie').header('Referrer-Policy','no-referrer');const user=await resolve(request);if(!user){reply.code(401).send({error:'Sign in with Telegram to use your private portfolio'});return null;}
    if(request.headers['x-watchlist-owner']!==undefined&&request.headers['x-watchlist-owner']!==user.id){reply.code(409).send({error:'Your account changed. Refresh and try again.'});return null;}
    if(mutation){const origin=telegramAuthConfig()?.origin??'https://kollens.com',development=process.env.NODE_ENV!=='production'&&request.headers.origin===`${request.protocol}://${request.headers.host}`;if(request.headers.origin!==origin&&!development){reply.code(403).send({error:'Request origin rejected'});return null;}
      const now=Date.now(),prior=attempts.get(user.id),entry=prior&&prior.until>now?prior:{until:now+60_000,count:0};attempts.set(user.id,entry);if(++entry.count>60){reply.code(429).header('Retry-After','60').send({error:'Try again shortly'});return null;}if(attempts.size>10000)for(const [id,value]of attempts)if(value.until<=now)attempts.delete(id);}
    return user;}
  async function result(reply:FastifyReply,work:()=>Promise<unknown>){try{return await work();}catch(error){if(error instanceof FreshPortfolioError)return reply.code(error.statusCode).send({error:error.message});app.log.warn({event:'fresh_portfolio_unavailable'},'Private portfolio temporarily unavailable');return reply.code(503).header('Retry-After','3').send({error:'Your private portfolio is temporarily unavailable. Try again shortly.'});}}
  const quiet={logLevel:'silent' as const};
  app.get('/api/journal/wallets',quiet,async(req,reply)=>{const user=await account(req,reply);if(user)return result(reply,()=>service.list(user.id));});
  app.post<{Body:{address?:unknown;label?:unknown}}>('/api/journal/wallets',quiet,async(req,reply)=>{const user=await account(req,reply,true);if(user)return result(reply,()=>service.add(user.id,req.body?.address,req.body?.label??''));});
  app.patch<{Params:{wallet:string};Body:{label?:unknown}}>('/api/journal/wallets/:wallet',quiet,async(req,reply)=>{const user=await account(req,reply,true);if(user)return result(reply,()=>service.updateLabel(user.id,req.params.wallet,req.body?.label));});
  app.delete<{Params:{wallet:string}}>('/api/journal/wallets/:wallet',quiet,async(req,reply)=>{const user=await account(req,reply,true);if(user)return result(reply,()=>service.remove(user.id,req.params.wallet));});
  for(const endpoint of ['summary','positions'])app.get<{Querystring:{wallet?:string}}>(`/api/journal/${endpoint}`,quiet,async(req,reply)=>{const user=await account(req,reply);if(user)return result(reply,()=>service.summary(user.id,req.query.wallet));});
  app.get<{Querystring:{wallet?:string;cursor?:string}}>('/api/journal/activity',quiet,async(req,reply)=>{const user=await account(req,reply);if(user)return result(reply,()=>service.activity(user.id,req.query.wallet,req.query.cursor));});
  app.get<{Params:{wallet:string;token:string};Querystring:{replay?:string;snapshot?:string}}>('/api/journal/wallets/:wallet/tokens/:token/activity',quiet,async(req,reply)=>{const user=await account(req,reply);if(user)return result(reply,async()=>{const value=await service.tokenActivity(user.id,req.params.wallet,req.params.token,req.query.replay==='true',req.query.snapshot);return value??reply.code(404).send({error:'Portfolio token activity not found'});});});
  app.get<{Params:{wallet:string;token:string};Querystring:{snapshot?:string}}>('/api/journal/wallets/:wallet/tokens/:token/replay-preparation',quiet,async(req,reply)=>{const user=await account(req,reply);if(!user)return;return result(reply,async()=>{const activity=await service.tokenActivity(user.id,req.params.wallet,req.params.token,true,req.query.snapshot);if(!activity)return reply.code(404).send({error:'Portfolio token activity not found'});const prepared=await options.replay.poll(activity,{scope:`account:${user.id}`});await service.authorize(user.id,activity.journal.walletAddress,activity.journal.membershipRevision);return prepared;});});
  app.get<{Params:{wallet:string;token:string};Querystring:{interval?:string;period?:string;before?:string;priority?:string;membership?:string;history?:string;workload?:string}}>('/api/journal/wallets/:wallet/tokens/:token/chart',quiet,async(req,reply)=>{
    const user=await account(req,reply);if(!user)return;return result(reply,async()=>{
      const wallet=freshPortfolioAddress(req.params.wallet),token=freshPortfolioAddress(req.params.token),member=await service.authorize(user.id,wallet,req.query.membership);
      const row=(await options.db.query(`SELECT t.*,CASE WHEN t.launch_status='preexisting' THEN NULL ELSE l.launched_at END AS launched_at FROM fresh.positions p JOIN fresh.tokens t ON t.address=p.token_address LEFT JOIN fresh.launch_facts l ON l.token_address=t.address
        WHERE p.scope_id=$1 AND t.address=$2 AND ${freshTrackedTokenSql('t')}`,[freshPortfolioScope(user.id,wallet),token])).rows[0];
      if(!row)return reply.code(404).send({error:'Portfolio token activity not found'});if(!options.charts)return reply.code(503).send({error:'Charts are temporarily unavailable'});
      const resolution=(req.query.interval??({'24h':'5m','7d':'1h','30d':'4h'}[req.query.period??'24h'])??'1m') as FreshResolution;
      if(!Object.hasOwn(freshChartIntervals,resolution))throw new FreshPortfolioError('Invalid chart interval');
      if(req.query.period&&!Object.hasOwn(freshChartPeriods,req.query.period)||req.query.workload&&!['browse','replay'].includes(req.query.workload))throw new FreshPortfolioError('Invalid chart request');
      const current=(options.now??Date.now)(),to=req.query.before?Number(req.query.before)*1000:current;
      if(!Number.isSafeInteger(to)||to<=0||to>current+1000)throw new FreshPortfolioError('Invalid chart time');
      if(options.requestQuote)await options.requestQuote(token);
      const launchedAt=new Date(row.launched_at??0).getTime(),from=freshChartFrom(launchedAt,to,resolution,{period:req.query.period,interval:req.query.interval,fullHistory:req.query.history==='full'}),supply=row.total_supply_raw!=null&&row.decimals!=null?q(String(row.total_supply_raw)).div(new FreshRational(10n**BigInt(row.decimals))).decimal(255):null;
      const controller=new AbortController(),abort=()=>controller.abort(new Error('Chart consumer disconnected')),closed=()=>{if(!reply.raw.writableEnded)abort();};req.raw.once('aborted',abort);reply.raw.once('close',closed);
      try{const chart=await options.charts.chart(token,{from,to,resolution,period:(req.query.interval??req.query.period??'24h') as ChartRange,foreground:req.query.priority!=='prefetch',workload:req.query.workload==='replay'?'replay':'browse',signal:controller.signal,quote:{priceUsd:row.price_usd,supply,timestamp:row.observed_at?iso(row.observed_at):null}});await service.authorize(user.id,wallet,member.revision);
        const full=req.query.history==='full',creationKnown=row.launched_at!=null,complete=creationKnown&&from<=launchedAt;return {...chart,fullHistory:full,historyComplete:full?complete:chart.historyComplete,historyPending:full&&creationKnown&&!complete,historyBefore:full&&creationKnown&&!complete?Math.floor(from/1000):undefined,
          ...(!creationKnown?{historyLoadStatus:'limited' as const,historyRecoveryPending:false,historyRecoveryReason:'token_creation_unknown'}:{})};}
      catch(error){await service.authorize(user.id,wallet,member.revision);if(!(error instanceof FreshChartError))throw error;return reply.header('Retry-After',String(Math.ceil((error.retryAfterMs||5000)/1000))).send({address:token,period:req.query.interval??req.query.period??'24h',source:'unavailable',candles:[],points:[],updatedAt:null,resolution,pending:error.reason!=='chart_unavailable',stale:true,fullHistory:req.query.history==='full',historyComplete:false,loadStatus:error.reason==='provider_cooldown'?'rate_limited':'provider_error',retryAfterMs:error.retryAfterMs||5000});}
      finally{req.raw.removeListener('aborted',abort);reply.raw.removeListener('close',closed);}
    });
  });
  return service;
}
