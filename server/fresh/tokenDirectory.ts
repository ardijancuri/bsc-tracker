import type {Pool} from 'pg';
import {freshPublicTokenSql,freshPublicTradeScopeSql} from './publicTokens.js';
import {tokenIdentity,tradeIdentity} from './reads.js';
import {FreshRational} from './accounting.js';
import {freshTrackedEventSql} from './tracking.js';

export const freshTokenDirectoryWindowMs=8*60*60_000;

/** A directory window belongs to this request, rather than to browser mount time.
 * Existing financial facts and the lifetime KOL token list are untouched. */
export function freshTokenDirectoryWindow(now=Date.now()){
  if(!Number.isFinite(now))throw new Error('Invalid token directory time');
  return{windowStart:new Date(now-freshTokenDirectoryWindowMs).toISOString(),windowEnd:new Date(now).toISOString(),windowHours:8 as const};
}

/** A failed refresh may retain a dated database quote for repair/debugging.
 * Discovery must not silently put that old value into a current-cap bucket. */
export function freshTokenDirectoryIdentity(row:Record<string,any>,now:number){
  const observed=row.observed_at==null?NaN:new Date(row.observed_at).getTime();let positive=false;
  try{positive=FreshRational.parse(String(row.price_usd)).compare(new FreshRational(0n))>0
    &&FreshRational.parse(String(row.market_cap_usd)).compare(new FreshRational(0n))>0;}catch{}
  const current=row.valuation_status==='ready'&&Number.isFinite(observed)&&observed<=now&&now-observed<=120_000&&positive;
  return tokenIdentity({...row,last_trade_at:row.last_public_trade_at,
    ...(current?{}:{price_usd:null,market_cap_usd:null,valuation_status:row.valuation_status==='ready'?'stale':row.valuation_status})});
}

/** Only authentic, confirmed live public buys/sells may put a token in the
 * tracker. Delayed node capture stays eligible by execution time: observed_live
 * governs alert delivery, rather than whether a genuine trade happened.
 * Private transfers and a token's global last_trade_at cannot renew discovery. */
const recentPublicTradeSql=`${freshPublicTradeScopeSql('e')}
  AND ${freshTrackedEventSql('e','directory_token')}
  AND e.occurred_at>=$1::timestamptz AND e.occurred_at<=$2::timestamptz`;

export async function readFreshTokenDirectory(db:Pick<Pool,'query'>,options:{limit?:number;offset?:number;withTrades?:boolean;now?:number}={}){
  const now=options.now??Date.now(),window=freshTokenDirectoryWindow(now),limit=Number.isFinite(options.limit)?Math.min(300,Math.max(1,Math.floor(options.limit!))):150,
    offset=Number.isFinite(options.offset)?Math.max(0,Math.floor(options.offset!)):0;
  // Page and total share one PostgreSQL statement snapshot, including an empty
  // page beyond the last offset. Existing wallet/time indexes serve this window.
  const selected=await db.query(`WITH recent AS MATERIALIZED(
    SELECT e.token_address,max(e.occurred_at) AS last_public_trade_at
    FROM fresh.visible_trades e JOIN fresh.kols tracked ON tracked.wallet_address=e.wallet_address AND tracked.is_tracked
    JOIN fresh.tokens directory_token ON directory_token.address=e.token_address
    JOIN fresh.recent_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash AND b.occurred_at=e.occurred_at
    WHERE ${recentPublicTradeSql} GROUP BY e.token_address
  ),available AS MATERIALIZED(
    SELECT t.*,t.today_utc::text AS utc_date,recent.last_public_trade_at FROM fresh.tokens t JOIN recent ON recent.token_address=t.address
    WHERE ${freshPublicTokenSql()} AND t.valuation_status<>'no_liquidity'
  ) SELECT page.*,totals.total FROM(SELECT count(*)::int AS total FROM available)totals
    LEFT JOIN LATERAL(SELECT * FROM available ORDER BY last_public_trade_at DESC,address LIMIT $3 OFFSET $4)page ON true
    ORDER BY page.last_public_trade_at DESC NULLS LAST,page.address`,[window.windowStart,window.windowEnd,limit+1,offset]);
  const rows=selected.rows.filter(row=>row.address!=null),items=rows.slice(0,limit).map(row=>freshTokenDirectoryIdentity(row,now));
  if(options.withTrades&&items.length){
    const trades=(await db.query(`SELECT e.*,t.name,t.symbol,t.logo_url,t.logo_data,k.display_name,k.avatar_url,k.twitter
      FROM unnest($3::text[]) candidate(address) CROSS JOIN LATERAL(
        SELECT e.* FROM fresh.visible_trades e JOIN fresh.kols tracked ON tracked.wallet_address=e.wallet_address AND tracked.is_tracked
        JOIN fresh.tokens directory_token ON directory_token.address=e.token_address
        JOIN fresh.recent_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash AND b.occurred_at=e.occurred_at
        WHERE e.token_address=candidate.address AND ${recentPublicTradeSql} ORDER BY e.occurred_at DESC,e.id DESC LIMIT 5
      )e JOIN fresh.tokens t ON t.address=e.token_address JOIN published_kols k ON k.address=e.wallet_address
      ORDER BY candidate.address,e.occurred_at DESC,e.id DESC`,[window.windowStart,window.windowEnd,items.map(token=>token.address)])).rows;
    const byToken=new Map<string,ReturnType<typeof tradeIdentity>[]>();
    for(const row of trades){const list=byToken.get(row.token_address)??[];list.push(tradeIdentity(row));byToken.set(row.token_address,list);}
    for(const token of items)Object.assign(token,{recentTrades:byToken.get(token.address)??[]});
  }
  return{items,total:selected.rows[0]?.total??0,nextOffset:rows.length>limit?offset+limit:null,nextCursor:rows.length>limit?String(offset+limit):null,...window};
}
