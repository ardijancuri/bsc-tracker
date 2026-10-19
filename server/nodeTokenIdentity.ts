import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {decodeNodeTokenIdentityText} from './nodeProjectionMetadata.js';
import {rpcBatch,type Rpc} from './rpc.js';
import {nonStockTokenSql} from './stockToken.js';
type DB=Pick<PoolClient,'query'>;
type IdentityEntry={tokenAddress:string;blockNumber:number;blockHash:string;timestamp:string;priority?:number};
const validAddress=(value:string)=>/^0x[a-f0-9]{40}$/i.test(value),validHash=(value:string)=>/^0x[a-f0-9]{64}$/i.test(value);

/** Optional display identity has its own durable queue. It never authorizes
 * token precision, prices, costs, claimed KOL names or private wallet labels. */
export async function ensureNodeTokenIdentitySchema(database:DB){
  await database.query(`CREATE TABLE IF NOT EXISTS node_token_identity_jobs(
    token_address text PRIMARY KEY,last_seen_block bigint,priority integer NOT NULL DEFAULT 0,
    requested_at timestamptz NOT NULL DEFAULT now(),next_attempt_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,last_error text,lease_id uuid,lease_until timestamptz,completed_at timestamptz);
    CREATE INDEX IF NOT EXISTS node_token_identity_pending ON node_token_identity_jobs(priority DESC,next_attempt_at) WHERE completed_at IS NULL;
    CREATE TABLE IF NOT EXISTS node_token_identity_evidence(token_address text NOT NULL,block_number bigint NOT NULL,
      block_hash text NOT NULL REFERENCES node_evidence_blocks(block_hash) ON DELETE CASCADE,timestamp timestamptz NOT NULL,
      symbol text,name text,source text NOT NULL DEFAULT 'node' CHECK(source='node'),checked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(token_address,block_hash),CHECK(symbol IS NOT NULL OR name IS NOT NULL));
    CREATE TABLE IF NOT EXISTS node_token_identity_publications(token_address text PRIMARY KEY,original_symbol text,original_name text);`);
}

/** Called by raw/market collection inside its existing canonical transaction. */
export async function enqueueNodeTokenIdentities(database:DB,entries:IdentityEntry[]){
  if(!entries.length)return;
  const normalized=entries.map(entry=>{
    if(!validAddress(entry.tokenAddress)||!validHash(entry.blockHash)||!Number.isSafeInteger(entry.blockNumber)||entry.blockNumber<0
      ||!Number.isFinite(Date.parse(entry.timestamp)))throw Error('node_identity_checkpoint_invalid');
    return{token_address:entry.tokenAddress.toLowerCase(),block_number:entry.blockNumber,block_hash:entry.blockHash.toLowerCase(),
      timestamp:new Date(entry.timestamp).toISOString(),priority:Math.min(100,Math.max(0,Math.trunc(entry.priority??0)))};
  });
  await database.query(`INSERT INTO node_token_identity_jobs(token_address,last_seen_block,priority)
    SELECT DISTINCT ON(q.token_address) q.token_address,q.block_number,q.priority FROM jsonb_to_recordset($1::jsonb)
      q(token_address text,block_number bigint,block_hash text,timestamp timestamptz,priority integer)
    JOIN node_evidence_blocks b ON b.block_number=q.block_number AND b.block_hash=q.block_hash AND b.timestamp=q.timestamp
    ORDER BY q.token_address,q.block_number DESC,q.priority DESC
    ON CONFLICT(token_address) DO UPDATE SET last_seen_block=GREATEST(node_token_identity_jobs.last_seen_block,EXCLUDED.last_seen_block),
      priority=GREATEST(node_token_identity_jobs.priority,EXCLUDED.priority),
      completed_at=CASE WHEN node_token_identity_jobs.completed_at>now()-interval '24 hours' THEN node_token_identity_jobs.completed_at ELSE NULL END,
      next_attempt_at=CASE WHEN EXCLUDED.priority>node_token_identity_jobs.priority THEN LEAST(node_token_identity_jobs.next_attempt_at,now())
        ELSE node_token_identity_jobs.next_attempt_at END`,[JSON.stringify(normalized)]);
}

export async function rollbackNodeTokenIdentities(database:DB,fromBlock:number){
  const affected=(await database.query('DELETE FROM node_token_identity_evidence WHERE block_number>=$1 RETURNING token_address',[fromBlock])).rows.map(row=>row.token_address);
  if(!affected.length)return;
  await publishIdentities(database,[...new Set<string>(affected)]);
  await database.query(`UPDATE node_token_identity_jobs SET completed_at=NULL,next_attempt_at=now(),last_error='chain_reorganization',lease_id=NULL,lease_until=NULL
    WHERE token_address=ANY($1::text[])`,[affected]);
}

async function publishIdentities(database:DB,tokens:string[]){
  await database.query(`UPDATE tokens t SET symbol=COALESCE((SELECT e.symbol FROM node_token_identity_evidence e
      JOIN node_evidence_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash WHERE e.token_address=t.address AND e.symbol IS NOT NULL
      ORDER BY e.block_number DESC LIMIT 1),p.original_symbol),
    name=COALESCE((SELECT e.name FROM node_token_identity_evidence e JOIN node_evidence_blocks b ON b.block_number=e.block_number AND b.block_hash=e.block_hash
      WHERE e.token_address=t.address AND e.name IS NOT NULL ORDER BY e.block_number DESC LIMIT 1),p.original_name)
    FROM node_token_identity_publications p WHERE p.token_address=t.address AND t.address=ANY($1::text[])`,[tokens]);
}

export function createNodeTokenIdentityService(options:{database:Pick<Pool,'query'|'connect'>;rpc:Rpc;now?:()=>number}){
  const {database,rpc}=options,now=options.now??Date.now;
  let lastLegacyDiscovery=-Infinity,lastPublicDiscovery=-Infinity,publicFeedAvailable:boolean|undefined;
  async function queueMissing(input:{limit?:number;priorityTokens?:string[];recentTokens?:string[]}={}){
    const normalize=(values:string[])=>[...new Set(values.filter(validAddress).map(token=>token.toLowerCase()))].slice(0,256);
    const selected=normalize(input.priorityTokens??[]),recent=normalize(input.recentTokens??[]),limit=Math.max(1,Math.min(128,input.limit??32));
    const wanted=new Map<string,{token_address:string;priority:number;rank:number}>();
    recent.forEach((token,rank)=>wanted.set(token,{token_address:token,priority:50,rank}));
    selected.forEach((token,rank)=>wanted.set(token,{token_address:token,priority:100,rank}));
    let queued=0;
    if(wanted.size){
      const values=JSON.stringify([...wanted.values()]);
      const result=await database.query(`INSERT INTO node_token_identity_jobs(token_address,priority)
        SELECT t.address,w.priority FROM jsonb_to_recordset($1::jsonb)w(token_address text,priority integer,rank integer)
        JOIN tokens t ON t.address=w.token_address WHERE NOT EXISTS(SELECT 1 FROM node_token_identity_jobs j WHERE j.token_address=t.address)
        ORDER BY w.priority DESC,w.rank,t.address LIMIT $2::integer ON CONFLICT DO NOTHING RETURNING token_address`,[values,limit]);
      queued=result.rowCount??0;
      await database.query(`UPDATE node_token_identity_jobs j SET priority=w.priority,next_attempt_at=LEAST(j.next_attempt_at,now())
        FROM jsonb_to_recordset($1::jsonb)w(token_address text,priority integer,rank integer)
        WHERE j.token_address=w.token_address AND j.completed_at IS NULL AND j.priority<w.priority`,[values]);
    }
    // A burst in one token can fill the caller's recent trade-row budget. Find
    // missing identities across the indexed public 24-hour feed independently,
    // rather than leaving older visible pages in alphabetical metadata backfill.
    if(queued<limit&&now()-lastPublicDiscovery>=30_000){
      publicFeedAvailable??=!!(await database.query(`SELECT to_regclass('public.trades') IS NOT NULL
        AND to_regclass('public.published_kols') IS NOT NULL AS available`)).rows[0]?.available;
      if(publicFeedAvailable){
        const result=await database.query(`WITH missing_recent AS(
          SELECT t.token_address,max(t.timestamp) AS last_trade FROM trades t
          JOIN published_kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address
          LEFT JOIN node_token_identity_jobs j ON j.token_address=t.token_address
          WHERE t.timestamp>now()-interval '24 hours' AND t.block_number IS NOT NULL AND k.is_tracked
            AND (NULLIF(trim(v.symbol),'') IS NULL OR NULLIF(trim(v.name),'') IS NULL
              OR lower(trim(v.symbol)) IN('unknown','unk','n/a') OR lower(trim(v.name)) IN('unknown','unk','n/a'))
            AND (j.token_address IS NULL OR j.completed_at IS NULL AND j.priority<50)
            AND ${nonStockTokenSql('t.token_address')}
          GROUP BY t.token_address ORDER BY max(t.timestamp) DESC,t.token_address LIMIT $1::integer
        ) INSERT INTO node_token_identity_jobs(token_address,priority)
          SELECT token_address,50 FROM missing_recent ORDER BY last_trade DESC,token_address
          ON CONFLICT(token_address) DO UPDATE SET priority=EXCLUDED.priority,next_attempt_at=LEAST(node_token_identity_jobs.next_attempt_at,now())
          WHERE node_token_identity_jobs.completed_at IS NULL AND node_token_identity_jobs.priority<EXCLUDED.priority
          RETURNING token_address`,[limit-queued]);
        queued+=result.rowCount??0;
      }
      lastPublicDiscovery=now();
    }
    // Legacy discovery is useful for older cards, but must not repeatedly sort
    // the whole token table or delay a new trade just because its address is high.
    if(queued<limit&&now()-lastLegacyDiscovery>=30_000){
      const result=await database.query(`INSERT INTO node_token_identity_jobs(token_address,priority)
        SELECT t.address,0 FROM tokens t WHERE (t.symbol IS NULL OR t.name IS NULL)
          AND NOT EXISTS(SELECT 1 FROM node_token_identity_jobs j WHERE j.token_address=t.address)
        ORDER BY t.address LIMIT $1::integer ON CONFLICT DO NOTHING RETURNING token_address`,[limit-queued]);
      queued+=result.rowCount??0;lastLegacyDiscovery=now();
    }
    return queued;
  }
  async function drain(input:{limit?:number}={}){
    const lease=randomUUID(),rows=(await database.query(`UPDATE node_token_identity_jobs j SET lease_id=$1::uuid,lease_until=now()+interval '60 seconds'
      FROM(SELECT token_address FROM node_token_identity_jobs WHERE completed_at IS NULL AND next_attempt_at<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY priority DESC,last_seen_block DESC NULLS LAST,requested_at,token_address
        LIMIT $2::integer FOR UPDATE SKIP LOCKED)q WHERE q.token_address=j.token_address RETURNING j.*`,[lease,Math.max(1,Math.min(8,input.limit??4))])).rows;
    if(!rows.length)return{claimed:0,complete:0,partial:0};
    const checkpoint=(await database.query(`SELECT block_number::text,block_hash,timestamp FROM node_evidence_blocks
      WHERE block_number<=COALESCE((SELECT (value->>'blockNumber')::bigint FROM worker_state WHERE key='node_collection'),-1)
      ORDER BY block_number DESC LIMIT 1`)).rows[0];
    let complete=0,partial=0;
    await Promise.all(rows.map(async row=>{
      let symbol:string|null=null,name:string|null=null,reason:string|null=null;
      try{
        if(!checkpoint)throw Error('node_identity_checkpoint_pending');
        const replies=await rpcBatch<string>(rpc,[{method:'eth_call',params:[{to:row.token_address,data:'0x95d89b41'},{blockHash:checkpoint.block_hash,requireCanonical:true}]},
          {method:'eth_call',params:[{to:row.token_address,data:'0x06fdde03'},{blockHash:checkpoint.block_hash,requireCanonical:true}]}]);
        symbol=replies[0]?.status==='fulfilled'?decodeNodeTokenIdentityText(replies[0].value,128):null;
        name=replies[1]?.status==='fulfilled'?decodeNodeTokenIdentityText(replies[1].value,256):null;
        if(!symbol||!name)reason=!symbol&&!name?'token_identity_unavailable':!name?'token_name_unavailable':'token_symbol_unavailable';
        const client=await database.connect();
        try{
          await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
          const current=(await client.query(`SELECT 1 FROM node_evidence_blocks b JOIN node_token_identity_jobs j ON j.token_address=$1
            WHERE b.block_number=$2 AND b.block_hash=$3 AND j.lease_id=$4::uuid FOR SHARE OF b`,[row.token_address,checkpoint.block_number,checkpoint.block_hash,lease])).rows.length;
          if(!current)throw Error('node_identity_checkpoint_changed');
          if(symbol||name){
            await client.query('INSERT INTO tokens(address) VALUES($1) ON CONFLICT DO NOTHING',[row.token_address]);
            await client.query(`INSERT INTO node_token_identity_publications(token_address,original_symbol,original_name)
              SELECT address,symbol,name FROM tokens WHERE address=$1 ON CONFLICT DO NOTHING`,[row.token_address]);
            await client.query(`INSERT INTO node_token_identity_evidence(token_address,block_number,block_hash,timestamp,symbol,name)
              VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(token_address,block_hash) DO UPDATE SET
              symbol=COALESCE(EXCLUDED.symbol,node_token_identity_evidence.symbol),name=COALESCE(EXCLUDED.name,node_token_identity_evidence.name)`,
            [row.token_address,checkpoint.block_number,checkpoint.block_hash,checkpoint.timestamp,symbol,name]);
            await publishIdentities(client,[row.token_address]);
          }
          const published=(await client.query(`SELECT
            EXISTS(SELECT 1 FROM node_token_identity_evidence e WHERE e.token_address=$1 AND e.symbol IS NOT NULL) AS symbol,
            EXISTS(SELECT 1 FROM node_token_identity_evidence e WHERE e.token_address=$1 AND e.name IS NOT NULL) AS name`,[row.token_address])).rows[0];
          const done=!!published?.symbol&&!!published?.name;
          await client.query(`UPDATE node_token_identity_jobs SET completed_at=CASE WHEN $3 THEN now() ELSE NULL END,
            attempts=CASE WHEN $3 THEN 0 ELSE attempts+1 END,last_error=CASE WHEN $3 THEN NULL ELSE $4 END,
            next_attempt_at=CASE WHEN $3 THEN now()+interval '24 hours' ELSE now()+LEAST(3600,30*POWER(2,LEAST(attempts,7)))::integer*interval '1 second' END,
            lease_id=NULL,lease_until=NULL WHERE token_address=$1 AND lease_id=$2::uuid`,[row.token_address,lease,done,reason]);
          await client.query('COMMIT');if(done)complete++;else partial++;
        }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      }catch(error){
        reason=error instanceof Error&&/^node_identity_[a-z_]+$/.test(error.message)?error.message:'token_identity_retry';
        await database.query(`UPDATE node_token_identity_jobs SET last_error=$3,attempts=attempts+1,next_attempt_at=now()+interval '30 seconds',
          lease_id=NULL,lease_until=NULL WHERE token_address=$1 AND lease_id=$2::uuid`,[row.token_address,lease,reason]);partial++;
      }
    }));
    return{claimed:rows.length,complete,partial};
  }
  return{queueMissing,drain};
}
