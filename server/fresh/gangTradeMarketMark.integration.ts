/** Only session-temporary tables; all fixtures are rolled back. */
import assert from'node:assert/strict';import{createHash}from'node:crypto';import{Pool,type PoolClient}from'pg';
import{decodeFreshEvidence,freshInteger}from'./capture.js';
import{recoverFreshGangTradeMarketMark,persistFreshGangTradeMarketMark,invalidateFreshTradeMarketMarks}from'./gangTradeMarketMark.js';
import{freshPendingTradesSchemaSql,removeFreshResolvedPendingTrades}from'./pendingTrades.js';
import{GANG_TOKEN_ADDRESS,freshTokenAdmissionDigest,type FreshExistingTokenPermission,type FreshTokenAdmission}from'./tracking.js';
import{FreshRational}from'./accounting.js';import{tradeIdentity}from'./reads.js';
import metadata from'../fixtures/gang-metadata-witness.json'with{type:'json'};import trades from'../fixtures/gang-trade-mark-witness.json'with{type:'json'};
const url=new URL(process.env.DATABASE_URL??'');if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||url.pathname!=='/kollens_fresh_20261022_24h')throw Error('local_fresh_fixture_required');
const db=new Pool({connectionString:url.href,max:1}),client=await db.connect(),wrapped={query:(sql:string,params?:unknown[])=>client.query(sql.replaceAll('fresh.','pg_temp.'),params)}as unknown as PoolClient;
const item=trades.entries.find(e=>decodeFreshEvidence(Buffer.from(e.payloadBase64,'base64')).stateEvidence?.calls.some(c=>c.data==='0xfeaf968c'))!,entry=decodeFreshEvidence(Buffer.from(item.payloadBase64,'base64'));
const p:FreshExistingTokenPermission={version:1,kind:'explicit_existing',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,startBlock:trades.boundary.block_number,startHash:trades.boundary.block_hash,
 startTime:trades.boundary.value.startTime,fromBlock:trades.boundary.block_number+1,approvedAt:'2026-10-25T12:00:00.000Z',reason:'user_approved_gang_only'};
const admission:FreshTokenAdmission={kind:'preexisting',permission:p,fromBlock:p.fromBlock,launchStatus:'preexisting',admissionDigest:freshTokenAdmissionDigest(p)};
const headers=new Map([metadata.source.block,metadata.runtime.block,metadata.after.block,...trades.entries.map(e=>e.block)].map(b=>[b.number,b])),checks:string[]=[];
try{
 const mark=await recoverFreshGangTradeMarketMark({entry,block:item.block,canonicalHeader:async n=>headers.get(n)??null,admission});assert(mark);
 await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s'");
 await client.query('CREATE TEMP TABLE wallets(address text PRIMARY KEY);CREATE TEMP TABLE tokens(address text PRIMARY KEY)');
 await client.query('CREATE TEMP TABLE financial_events(LIKE fresh.financial_events INCLUDING ALL) ON COMMIT DROP');
 for(const column of['market_cap_usd text','market_mark jsonb','provenance jsonb'])await client.query('ALTER TABLE pg_temp.financial_events ADD COLUMN IF NOT EXISTS '+column);
 await wrapped.query(freshPendingTradesSchemaSql);
 await client.query('INSERT INTO pg_temp.wallets VALUES($1)',[mark.walletAddress]);await client.query('INSERT INTO pg_temp.tokens VALUES($1)',[GANG_TOKEN_ADDRESS]);
 await client.query(`INSERT INTO pg_temp.pending_trades(id,execution_key,wallet_address,token_address,kind,raw_quantity,block_number,block_hash,transaction_hash,transaction_index,execution_index,log_index,occurred_at,evidence_hash)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13)`,[mark.eventId,mark.executionKey,mark.walletAddress,mark.tokenAddress,mark.side,mark.rawQuantity,mark.blockNumber,mark.blockHash,mark.transactionHash,
  Number(freshInteger(entry.transaction.transactionIndex)),Number(freshInteger(entry.receipt.logs.find(l=>l.address===GANG_TOKEN_ADDRESS)!.logIndex)),mark.observedAt,createHash('sha256').update(JSON.stringify([entry.transaction,entry.receipt])).digest('hex')]);
 await persistFreshGangTradeMarketMark(wrapped,mark);
 const pending=(await client.query('SELECT * FROM pg_temp.visible_trades')).rows[0];assert.equal(pending.quantity,null);assert.equal(pending.market_cap_usd,mark.marketCapUsd);assert.equal(pending.accounting_status,'pending_precision');
 checks.push('Current schema creates mark columns before the union view; pending MCAP does not invent token quantity or financial value');
 const quantity=new FreshRational(BigInt(mark.rawQuantity),10n**18n).decimal();
 await client.query(`INSERT INTO pg_temp.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,block_number,block_hash,transaction_hash,transaction_index,execution_index,log_index,occurred_at)
  VALUES($1,$2,$3,$4,$5,$6,'1','0',$7,$8,$9,$10,0,$11,$12)`,[mark.eventId,mark.executionKey,mark.walletAddress,mark.tokenAddress,mark.side,quantity,mark.blockNumber,mark.blockHash,mark.transactionHash,
  Number(freshInteger(entry.transaction.transactionIndex)),Number(freshInteger(entry.receipt.logs.find(l=>l.address===GANG_TOKEN_ADDRESS)!.logIndex)),mark.observedAt]);
 assert.equal((await client.query('SELECT count(*)::int n FROM pg_temp.visible_trades')).rows[0].n,1);
 const before=(await client.query("SELECT to_jsonb(f)-'market_cap_usd'-'market_mark' AS row FROM pg_temp.financial_events f")).rows[0].row;
 await removeFreshResolvedPendingTrades(wrapped,[mark.eventId]);const promoted=(await client.query('SELECT * FROM pg_temp.visible_trades')).rows[0];
 assert.equal(promoted.market_cap_usd,mark.marketCapUsd);assert.equal((await client.query('SELECT count(*)::int n FROM pg_temp.pending_trades')).rows[0].n,0);
 assert.deepEqual((await client.query("SELECT to_jsonb(f)-'market_cap_usd'-'market_mark' AS row FROM pg_temp.financial_events f")).rows[0].row,before);
 assert.equal(tradeIdentity(promoted).marketCapUsd,mark.marketCapUsd);checks.push('Exact execution promotion deduplicates visibility and preserves the authenticated mark without changing quantities, fees or proceeds');
 await assert.rejects(persistFreshGangTradeMarketMark(wrapped,structuredClone(mark)),/not_validated/);
 await invalidateFreshTradeMarketMarks(wrapped,Number(mark.blockNumber)-1);const invalid=(await client.query('SELECT market_cap_usd,market_mark FROM pg_temp.financial_events')).rows[0];
 assert.equal(invalid.market_cap_usd,null);assert.equal(invalid.market_mark.canonicalInvalid,true);assert.equal(invalid.market_mark.marketCapUsd,mark.marketCapUsd);
 checks.push('Unvalidated copies are rejected; reorg invalidates the displayed value while retaining its original evidence');
 console.log(JSON.stringify({ok:true,checks,temporaryTablesOnly:true,persistentAppWrites:0,providerRequests:0}));
}finally{await client.query('ROLLBACK');client.release();await db.end();}
