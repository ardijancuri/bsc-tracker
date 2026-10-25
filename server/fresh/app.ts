import Fastify from 'fastify';
import type { Pool } from 'pg';
import type { FreshServices } from './services.js';
import { createFreshServices } from './services.js';
import { kolIdentity,tokenIdentity,publicScope } from './reads.js';
import { freshUtcDay,FreshRational,freshDecimal } from './accounting.js';
import { registerFreshFavorites } from './favorites.js';
import { registerFreshPortfolio } from './portfolio.js';
import { registerCreatorRoutes } from '../creatorApi.js';
import { registerTelegramAuthRoutes,telegramAuthConfig,resolveAuthUser } from '../telegramAuth.js';
import { createTelegramBotLogin } from '../telegramBotLogin.js';
import { createTelegramAvatarCache,registerTelegramAvatarRoute } from '../telegramBotAvatar.js';
import { createTelegramBot,telegramBotConfig } from '../telegramBot.js';
import { createTelegramNotifications } from '../telegramNotifications.js';
import { registerTelegramNotificationRoutes } from '../telegramNotificationsApi.js';
import { captureGuestWatchlist,mergeGuestWatchlist } from '../accountWatchlist.js';
import { FreshChartError,freshChartIntervals,freshChartPeriods,freshChartFrom,type FreshResolution } from './charts.js';
import {freshPublicPosition} from './publicPositions.js';
import {selectFreshQuote} from './quoteQueue.js';
import {registerFreshFeatures} from './features.js';
import {registerChampionshipRoutes} from '../championshipApi.js';
import {createChampionshipService} from '../championship.js';
import {freshPublicTokenSql,freshPublicTradeScopeSql} from './publicTokens.js';
import {freshPositionReceiptRelevantSql,freshPendingTradeScopeSql} from './positionDependencies.js';
import {freshPositionWalletGapSql} from './balanceScheduling.js';
import {readFreshTokenDirectory} from './tokenDirectory.js';
import {freshTrackedEventSql,freshScopeTokenBoundarySql} from './tracking.js';
import{freshScopeTokenCaptureSql}from'./gangTokenCoverage.js';

const address=(s:string)=>/^0x[0-9a-f]{40}$/i.test(s)?s.toLowerCase():null;
const num=(s:unknown,defaultValue=50,max=100)=>Number.isInteger(Number(s))&&Number(s)>0?Math.min(Number(s),max):defaultValue;
const iso=(s:unknown)=>s==null?null:new Date(s as string).toISOString();
const q=FreshRational.parse;
/** The production entrypoint uses only these adapters; none of the retired node/provider accounting services is started. */
export async function createFreshApp(db:Pool,options:{services?:FreshServices;logger?:boolean}={}) {
  const app=Fastify({logger:options.logger?{redact:['req.headers.cookie','req.headers.authorization','req.headers.x-telegram-bot-api-secret-token','res.headers.set-cookie'],
    serializers:{req(request){const url=request.url?.split('?')[0]??'';return{method:request.method,url:url.startsWith('/api/journal')?'/api/journal/[private]':url.startsWith('/api/auth')?'/api/auth/[private]':url};}}}:false,
    trustProxy:process.env.NODE_ENV==='production'});
  const services=options.services??createFreshServices(db),{reads,charts,replay}=services;
  const cfg=telegramBotConfig(),bot=cfg?.webhookSecret?createTelegramBot(cfg):null;
  const alerts=createTelegramNotifications({db,config:cfg,bot,stateTable:'fresh.checkpoints'});
  const login=createTelegramBotLogin({pool:db,config:telegramAuthConfig(),bot,captureGuest:captureGuestWatchlist,mergeGuest:mergeGuestWatchlist,
    avatarUrl:bot?createTelegramAvatarCache(db,bot.profilePhoto):undefined});
  login.registerRoutes(app);registerTelegramAvatarRoute(app,db);
  registerTelegramAuthRoutes(app,{captureGuest:captureGuestWatchlist,mergeGuest:mergeGuestWatchlist,botLogin:login,
    notificationConsent:{available:alerts.available,onAuthorized:alerts.authorize,onFailed:alerts.consentFailed}});
  registerTelegramNotificationRoutes(app,{pool:db,available:alerts.available,state:alerts.state,update:alerts.update,mute:alerts.mute,
    webhook:alerts.webhook,botLoginStart:login.handleStart});
  registerCreatorRoutes(app,{pool:db});registerFreshFavorites(app,db);registerFreshPortfolio(app,{db,reads,replay,charts,requestQuote:token=>selectFreshQuote(db,token)});
  registerFreshFeatures(app,{db});
  // The existing external competition board has its own bounded in-memory
  // cache. It neither writes financial response copies nor drives KOL P&L.
  registerChampionshipRoutes(app,createChampionshipService());
  app.setErrorHandler((error,request,reply)=>{app.log.warn({event:'fresh_request_failed',method:request.method},'Request unavailable');
    if(!reply.sent)reply.code(503).header('Cache-Control','no-store').header('Retry-After','3').send({error:'Data is temporarily unavailable. Try again shortly.'});});
  app.get('/api/health',async()=>{await db.query('SELECT 1');return{ok:true,service:'kollens-fresh',state:await reads.state()};});
  app.get('/api/overview',async()=>{
    const [state,counts]=await Promise.all([reads.state(),db.query(`SELECT (SELECT count(*)::int FROM fresh.kols WHERE is_tracked) AS "trackedKols",
      COALESCE((SELECT sum(today_trade_count)::int FROM fresh.kols WHERE is_tracked AND today_utc=(now() AT TIME ZONE 'UTC')::date),0) AS "trades24h",
      (SELECT count(*)::int FROM fresh.tokens WHERE today_utc=(now() AT TIME ZONE 'UTC')::date AND today_buy_count+today_sell_count>0) AS "tokens24h",
      (SELECT max(last_trade_at) FROM fresh.kols WHERE is_tracked) AS "latestTradeAt",(SELECT max(rolling_metrics_updated_at) FROM fresh.kols WHERE is_tracked) AS "lastLeaderboardAt",
      (SELECT max(observed_at) FROM fresh.tokens) AS "lastTokenPriceAt"`)]);
    return{...counts.rows[0],lastNodeBlock:state.capture?.block_number??null,nodeLagBlocks:state.capture?.value?.headBlock?Number(state.capture.value.headBlock)-Number(state.capture.block_number):null,
      lastNodeAt:state.capture?.updated_at??null,bnbPriceUsd:state.quote?.value?.bnbPriceUsd??null,bnbPriceAt:state.quote?.updated_at??null,
      leaderboardSource:'node_fifo',utcDay:freshUtcDay(),trackingBoundary:state.start??null};
  });
  app.get('/api/leaderboard',()=>reads.leaderboard());
  app.get<{Querystring:{limit?:string;cursor?:string;kol?:string;token?:string;window?:string}}>('/api/trades',async req=>reads.trades({limit:num(req.query.limit),cursor:req.query.cursor,
    wallet:req.query.kol?address(req.query.kol)??'invalid':undefined,token:req.query.token?address(req.query.token)??'invalid':undefined,today:req.query.window==='today',window:req.query.window==='24h'?'24h':undefined}));
  const publicToken=freshPublicTokenSql();
  async function visibleTokenCounters(token:string){return(await db.query(`SELECT count(DISTINCT e.wallet_address)::int AS today_kol_count,
    count(*) FILTER(WHERE e.kind='buy')::int AS today_buy_count,count(*) FILTER(WHERE e.kind='sell')::int AS today_sell_count,
    COALESCE(sum(e.amount_usd::numeric),0)::text AS today_volume_q FROM fresh.visible_trades e JOIN fresh.tokens t ON t.address=e.token_address
    WHERE e.token_address=$1 AND ${freshPublicTradeScopeSql('e')} AND ${freshTrackedEventSql('e','t')}
    AND e.occurred_at>=$2::timestamptz AND e.occurred_at<=$3::timestamptz`,[token,`${freshUtcDay()}T00:00:00.000Z`,new Date().toISOString()])).rows[0];}
  async function tokens(wallet?:string,limit=150,offset=0){
    const values:unknown[]=[];let join='',walletTrade='';if(wallet){values.push(wallet);
      walletTrade=`AND EXISTS(SELECT 1 FROM fresh.visible_trades e WHERE e.token_address=t.address AND e.wallet_address=$1 AND ${freshPublicTradeScopeSql('e')} AND ${freshTrackedEventSql('e','t')})`;}
    values.push(limit+1,offset);
    const result=await db.query(`SELECT t.*,t.today_utc::text AS utc_date FROM fresh.tokens t ${join} WHERE ${publicToken} ${walletTrade}
      ORDER BY t.last_trade_at DESC NULLS LAST,t.address LIMIT $${values.length-1} OFFSET $${values.length}`,values);
    const items=result.rows.slice(0,limit).map(r=>tokenIdentity({...r,...(r.utc_date===freshUtcDay()?{}:{today_buy_count:0,today_sell_count:0,today_kol_count:0,today_volume_q:'0'})}));
    if(wallet){const summary=await reads.summaries(wallet,items.map(t=>t.address));for(const item of items)Object.assign(item,{accountingSummary:summary[item.address]});}
    return{items,nextOffset:result.rows.length>limit?offset+limit:null,nextCursor:result.rows.length>limit?String(offset+limit):null};
  }
  app.get<{Querystring:{limit?:string;offset?:string;withTrades?:string}}>('/api/tokens',req=>readFreshTokenDirectory(db,
    {limit:num(req.query.limit,150,300),offset:Math.max(0,Number(req.query.offset)||0),withTrades:req.query.withTrades==='1'}));
  app.get<{Params:{address:string};Querystring:{cursor?:string}}>('/api/kols/:address/tokens',req=>tokens(address(req.params.address)??'invalid',6,Math.max(0,Number(req.query.cursor)||0)));
  app.get<{Params:{address:string}}>('/api/kols/:address',async(req,reply)=>{
    const key=address(req.params.address);if(!key)return reply.code(400).send({error:'Invalid wallet'});
    const [board,page]=await Promise.all([reads.leaderboard(),tokens(key,6)]);
    const trades=await reads.trades({wallet:key,limit:10,window:'24h',windowStart:board.windowStart,windowEnd:board.windowEnd});
    const kol=board.items.find(k=>k.address===key);return{kol:kol??null,stats:kol??null,trades:trades.items,tradesNextCursor:trades.nextCursor,
      tradeCount24h:kol?.tradeCount24h??0,buyCount24h:kol?.buyCount24h??0,sellCount24h:kol?.sellCount24h??0,tokens:page.items,tokensNextCursor:page.nextCursor,
      period:board.period,windowStart:board.windowStart,windowEnd:board.windowEnd,utcDay:board.utcDay,trackingBoundary:board.trackingBoundary};
  });
  app.get<{Params:{address:string};Querystring:{tokens?:string}}>('/api/kols/:address/token-summaries',async(req,reply)=>{
    const key=address(req.params.address),selected=(req.query.tokens??'').split(',').filter(Boolean);
    if(!key||!selected.length||selected.length>24||selected.some(s=>!address(s)))return reply.code(400).send({error:'Invalid summary request'});
    return{summaries:await reads.summaries(key,selected.map(s=>s.toLowerCase()))};
  });
  for(const mode of ['activity','replay-preparation']as const)app.get<{Params:{address:string;token:string};Querystring:{snapshot?:string;replay?:string;pnl?:string;profile?:string}}>(`/api/kols/:address/tokens/:token/${mode}`,async(req,reply)=>{
    const wallet=address(req.params.address),token=address(req.params.token);if(!wallet||!token)return reply.code(400).send({error:'Invalid wallet or token'});
    const saved=req.query.snapshot?await replay.authorizedSaved(req.query.snapshot,'public'):null;
    if(req.query.snapshot&&(!saved||saved.kol.address!==wallet||saved.token.address!==token))return reply.code(410).send({error:'Prepare this replay again.'});
    const selected=mode==='replay-preparation'||req.query.replay==='true'||req.query.pnl==='true'&&req.query.profile!=='true';
    const activity=saved??await reads.activity(wallet,token,publicScope(wallet),selected);
    if(!activity)return reply.code(404).send({error:'KOL token activity not found'});reply.header('Cache-Control','no-store');
    if(!saved)await selectFreshQuote(db,token);
    if(selected)replay.remember(activity,'public');
    return mode==='activity'?activity:replay.poll(activity);
  });
  app.post<{Body:{manifest?:string;scope?:string}}>('/api/replays/validate',async(req,reply)=>{
    const manifest=req.body?.manifest??'';let selected='public';
    try{const claims=JSON.parse(Buffer.from(manifest.split('.')[0],'base64url').toString());if(claims.scope!=='public'){
      const user=await resolveAuthUser(req,db);if(!user)return reply.code(401).send({valid:false});selected=`account:${user.id}`;
      const owner=req.headers['x-watchlist-owner'];if(owner!==undefined&&owner!==user.id)return reply.code(409).send({valid:false});
    }}catch{return reply.code(400).send({valid:false});}
    const result=await replay.validate(manifest,selected);
    return result.valid?result:reply.code(410).send({valid:false,error:'Replay expired or its evidence changed. Prepare it again.'});
  });
  app.get<{Params:{address:string}}>('/api/tokens/:address',async(req,reply)=>{
    const key=address(req.params.address);if(!key)return reply.code(400).send({error:'Invalid token'});
    const row=(await db.query(`SELECT t.*,t.today_utc::text AS utc_date FROM fresh.tokens t WHERE t.address=$1 AND ${publicToken}`,[key])).rows[0];
    if(!row)return{token:null,trades:[],kols:[]};
    await selectFreshQuote(db,key);
    const [trades,kols,counts]=await Promise.all([reads.trades({token:key,limit:20}),db.query(`SELECT p.* FROM published_kols p WHERE p.is_tracked
      AND EXISTS(SELECT 1 FROM fresh.visible_trades trader_event JOIN fresh.tokens traded_token ON traded_token.address=trader_event.token_address
        WHERE trader_event.wallet_address=p.address AND trader_event.token_address=$1 AND ${freshPublicTradeScopeSql('trader_event')}
        AND ${freshTrackedEventSql('trader_event','traded_token')}) ORDER BY p.display_name`,[key]),
      visibleTokenCounters(key)]);
    return{token:tokenIdentity({...row,...counts,utc_date:freshUtcDay()}),trades:trades.items,tradesNextCursor:trades.nextCursor,kols:kols.rows.map(kolIdentity)};
  });
  app.get<{Params:{address:string};Querystring:{interval?:string;period?:string;before?:string;history?:string;priority?:string;workload?:string}}>('/api/tokens/:address/chart',async(req,reply)=>{
    const key=address(req.params.address),resolution=(req.query.interval??({'24h':'5m','7d':'1h','30d':'4h'}[req.query.period??'24h'])??'1m') as FreshResolution;
    if(!key||!Object.hasOwn(freshChartIntervals,resolution))return reply.code(400).send({error:'Invalid chart interval'});
    if(req.query.period&&!Object.hasOwn(freshChartPeriods,req.query.period)||req.query.workload&&!['browse','replay'].includes(req.query.workload))return reply.code(400).send({error:'Invalid chart request'});
    const token=(await db.query(`SELECT t.*,CASE WHEN t.launch_status='preexisting' THEN NULL ELSE l.launched_at END AS launched_at FROM fresh.tokens t LEFT JOIN fresh.launch_facts l ON l.token_address=t.address WHERE t.address=$1 AND ${publicToken}`,[key])).rows[0];
    if(!token)return reply.code(404).send({error:'Token not found'});
    if(req.query.priority!=='prefetch')await selectFreshQuote(db,key);
    const to=req.query.before?Number(req.query.before)*1000:Date.now(),seconds=freshChartIntervals[resolution];
    if(!Number.isSafeInteger(to)||to<=0||to>Date.now()+1000)return reply.code(400).send({error:'Invalid chart time'});
    const launchedAt=new Date(token.launched_at??0).getTime(),from=freshChartFrom(launchedAt,to,resolution,{period:req.query.period,interval:req.query.interval,fullHistory:req.query.history==='full'}),supply=token.total_supply_raw!=null&&token.decimals!=null?q(String(token.total_supply_raw)).div(new FreshRational(10n**BigInt(token.decimals))).decimal(255):null;
    const controller=new AbortController(),abort=()=>controller.abort(new DOMException('Chart consumer disconnected','AbortError')),closed=()=>{if(!reply.raw.writableEnded)abort();};
    req.raw.once('aborted',abort);reply.raw.once('close',closed);
    try{const chart=await charts.chart(key,{from,to,resolution,period:(req.query.interval??req.query.period??'24h') as import('../../shared/intelligence.js').ChartRange,
      foreground:req.query.priority!=='prefetch',workload:req.query.workload==='replay'?'replay':'browse',signal:controller.signal,quote:{priceUsd:token.valuation_status==='ready'?token.price_usd:null,supply,timestamp:iso(token.observed_at)}});
      const full=req.query.history==='full',creationKnown=token.launched_at!=null,complete=creationKnown&&from<=launchedAt;return{...chart,fullHistory:full,historyComplete:full?complete:chart.historyComplete,
        historyPending:full&&creationKnown&&!complete,historyBefore:full&&creationKnown&&!complete?Math.floor(from/1000):undefined,
        ...(!creationKnown?{historyLoadStatus:'limited' as const,historyRecoveryPending:false,historyRecoveryReason:'token_creation_unknown'}:{})};}
    catch(error){if(!(error instanceof FreshChartError))throw error;return reply.header('Retry-After',String(Math.ceil((error.retryAfterMs||5000)/1000))).send({address:key,period:req.query.interval??req.query.period??'24h',source:'unavailable',candles:[],points:[],updatedAt:null,resolution,pending:error.reason!=='chart_unavailable',stale:true,
      fullHistory:req.query.history==='full',historyComplete:false,historyPending:req.query.history==='full'&&error.reason!=='chart_unavailable',
      ...(req.query.history==='full'?{historyLoadStatus:error.reason==='provider_cooldown'?'rate_limited':error.reason==='chart_unavailable'?'limited':'provider_error',
        historyRecoveryPending:error.reason!=='chart_unavailable',historyRecoveryReason:error.reason,historyRetryAfterMs:error.retryAfterMs||5000,
        historyBefore:req.query.before?Number(req.query.before):Math.floor(from/1000)}:{}),
      loadStatus:error.reason==='provider_cooldown'?'rate_limited':'provider_error',retryAfterMs:error.retryAfterMs||5000});}
    finally{req.raw.removeListener('aborted',abort);reply.raw.removeListener('close',closed);}
  });
  app.get<{Params:{address:string}}>('/api/token-image/:address',async(req,reply)=>{const row=(await db.query(`SELECT logo_data,logo_mime FROM fresh.tokens t WHERE t.address=$1 AND ${publicToken}`,[address(req.params.address)??'invalid'])).rows[0];
    return row?.logo_data?reply.header('Cache-Control','public,max-age=3600').type(row.logo_mime??'image/webp').send(row.logo_data):reply.code(404).send();});
  for(const kind of ['website','translation']as const)app.get<{Params:{address:string}}>(`/api/tokens/:address/${kind}`,async req=>{
    const key=address(req.params.address),row=(await db.query(`SELECT website_url FROM fresh.tokens t WHERE t.address=$1 AND ${publicToken}`,[key])).rows[0];
    return kind==='website'?{tokenAddress:key,websiteUrl:row?.website_url??null}:{tokenAddress:key,englishName:null};});
  app.get<{Params:{address:string}}>('/api/tokens/:address/market',async req=>{const row=(await db.query(`SELECT t.*,t.today_utc::text AS utc_date FROM fresh.tokens t WHERE t.address=$1 AND ${publicToken}`,[address(req.params.address)??'invalid'])).rows[0];
    const token=row?tokenIdentity({...row,...await visibleTokenCounters(row.address),utc_date:freshUtcDay()}):null;if(token)await selectFreshQuote(db,token.address);
    return{period:'24h',utcDay:freshUtcDay(),token:token?{...token,kind:'token',periodVolumeUsd:token.volume24hUsd,periodKolCount:token.kolCount24h,priceHistory:[]}:null};});
  for(const mode of ['kols','tokens']as const)app.get<{Params:{address:string}}>(`/api/${mode}/:address/positions`,async req=>{
    const key=address(req.params.address)??'invalid',rows=(await db.query(`SELECT p.*,s.wallet_addresses,last.block_number AS last_event_block,
      ${freshScopeTokenCaptureSql('s','p.token_address')} AS capture_block,
      ${freshPositionWalletGapSql("(SELECT block_number FROM fresh.checkpoints WHERE key='capture')")} AS wallet_gap,
      (EXISTS(SELECT 1 FROM fresh.recent_evidence e LEFT JOIN fresh.recent_blocks h USING(block_number,block_hash) WHERE e.wallet_addresses&&s.wallet_addresses AND ${freshScopeTokenBoundarySql('s','p.token_address','e.block_number','h.occurred_at',{allowMissingTime:true})} AND e.decoder_status<>'done'
        AND ${freshPositionReceiptRelevantSql('e','p.token_address')}) OR ${freshPendingTradeScopeSql()}) AS decoding_pending,
      EXISTS(SELECT 1 FROM fresh.jobs j WHERE j.kind='registration_capture' AND j.reference=ANY(s.wallet_addresses) AND j.state NOT IN('done','cancelled')) AS registration_pending
      FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id JOIN fresh.kols k ON s.id='kol:'||k.wallet_address
      JOIN fresh.tokens t ON t.address=p.token_address LEFT JOIN fresh.financial_events last ON last.id=p.last_event_id
      WHERE s.active AND k.is_tracked AND ${publicToken} AND ${mode==='kols'?'k.wallet_address':'p.token_address'}=$1`,[key])).rows;
    return{items:rows.map(freshPublicPosition)};});
  app.get<{Querystring:{q?:string}}>('/api/search',async req=>{const term=(req.query.q??'').trim().slice(0,120);if(!term)return{kols:[],tokens:[]};const[kols,tokens]=await Promise.all([
    db.query(`SELECT * FROM published_kols WHERE is_tracked AND (address ILIKE $1 OR display_name ILIKE $1) LIMIT 12`,[`%${term}%`]),
    db.query(`SELECT t.*,t.today_utc::text AS utc_date FROM fresh.tokens t WHERE ${publicToken} AND (t.address ILIKE $1 OR t.symbol ILIKE $1 OR t.name ILIKE $1) LIMIT 12`,[`%${term}%`])]);return{kols:kols.rows.map(kolIdentity),tokens:tokens.rows.map(tokenIdentity)};});
  app.get('/api/stream',async(req,reply)=>{reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});reply.raw.write('data: update\n\n');
    const timer=setInterval(()=>reply.raw.write('data: update\n\n'),5000);req.raw.once('close',()=>clearInterval(timer));});
  return{app,services,alerts};
}
