// Session-temporary PostgreSQL fixtures only. All X/OpenAI/provider requests are disabled.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import twitterText from 'twitter-text';
import { pool as originalPool } from './db.js';
import type { Pool } from 'pg';
import { ensureXTokenPostSchema, rollbackXTokenPosts } from './xTokenPostSchema.js';
import { createXTokenPosts } from './xTokenPosts.js';
import { readTokenPostCandidates, tokenPostEvidenceIsCanonical } from './xTokenPostEligibility.js';
import { XTokenPostTransportError, type XTokenPostTransport } from './xTokenPostTransport.js';
import type { TokenPostEvidence, TokenPostNarrative } from '../shared/xTokenPosts.js';

const connection = new URL(process.env.DATABASE_URL || '');
if (!['127.0.0.1', 'localhost'].includes(connection.hostname) || !( /^\/bscan_x_posts_test(?:_\d+)?$/.test(connection.pathname) || connection.port==='5439' && connection.pathname==='/kollens_replay_gap_20261029')) {
  throw new Error('Use an explicitly allowed local test database');
}
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network transports disabled by X integration test'); };
const baseTime = Date.parse('2026-10-20T12:00:00Z'), asOf = new Date(baseTime - 10_000).toISOString();
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const token = `0x${'1'.repeat(36)}7777`;
const facts: TokenPostNarrative = { kind: 'facts_only', text: '', sourceIds: [], reason: 'openai_not_configured', aiAssisted: false };
let assertions = 0;
const check = (condition: unknown, message: string) => { assertions++; assert.ok(condition, message); };
async function jobRows() { return (await pool.query('SELECT * FROM x_token_post_jobs ORDER BY first_qualified_at,id')).rows; }

// A single dedicated session shadows every application relation with TEMP
// tables. SQL qualification and fake delivery write only these disposable rows.
const session = await originalPool.connect();
const query = (sql: string, args?: unknown[]) => session.query(sql.replaceAll('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE IF NOT EXISTS')
  .replace(/fresh\.([a-z_]+)/g, 'pg_temp.fixture_$1'), args);
const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
async function seedEligibility() {
  await query(`CREATE TEMP TABLE fixture_checkpoints(key text,block_number bigint,block_hash text);
    CREATE TEMP TABLE fixture_recent_blocks(block_number bigint,block_hash text,occurred_at timestamptz);
    CREATE TEMP TABLE fixture_wallets(address text,active boolean,monitoring_from_block bigint,monitoring_to_block bigint,decode_gap_from_block bigint);
    CREATE TEMP TABLE fixture_kols(wallet_address text,display_name text,avatar_url text,is_tracked boolean);
    CREATE TEMP TABLE published_kols(address text,is_tracked boolean,twitter text);
    CREATE TEMP TABLE fixture_accounting_scopes(id text,kind text,active boolean,account_id text,wallet_addresses text[],starts_block bigint,starts_at timestamptz);
    CREATE TEMP TABLE fixture_tokens(address text,name text,symbol text,logo_url text,logo_data bytea,website_url text,is_meme boolean,
      launch_status text,valuation_status text,price_source text,total_supply_raw numeric,decimals int,observed_at timestamptz,
      observed_block bigint,observed_hash text,market_cap_usd numeric);
    CREATE TEMP TABLE fixture_positions(scope_id text,token_address text,balance_quantity text,balance_block bigint,balance_hash text,
      balance_checked_at timestamptz,last_event_at timestamptz,quantity_q text,balance_status text,revision bigint);
    CREATE TEMP TABLE fixture_financial_events(id text,wallet_address text,token_address text,kind text,canonical boolean,observed_live boolean,
      block_number bigint,occurred_at timestamptz,quantity text);
    CREATE TEMP TABLE fixture_recent_evidence(wallet_addresses text[],block_number bigint,decoder_status text);`);
  await query('INSERT INTO fresh.checkpoints VALUES($1,1000,$2)',['capture',hash(1000)]);
  await query('INSERT INTO fresh.recent_blocks VALUES(1000,$1,$2),(999,$3,$4)',[hash(1000),asOf,hash(999),new Date(baseTime-11000)]);
  await query(`INSERT INTO fresh.tokens(address,name,symbol,is_meme,launch_status,valuation_status)
    VALUES($1,'Integration meme','MEME',true,'eligible','pending')`,[token]);
  for(let n=1;n<=5;n++){
    const a=address(n),scope='kol:'+a;
    await query('INSERT INTO fresh.wallets VALUES($1,true,1,NULL,NULL)',[a]);
    await query('INSERT INTO fresh.kols VALUES($1,$2,NULL,$3)',[a,'Public creator '+n,n<=4]);
    await query('INSERT INTO published_kols VALUES($1,true,$2)',[a,'public_creator'+n]);
    await query(`INSERT INTO fresh.accounting_scopes VALUES($1,$2,true,NULL,ARRAY[$3::text],1,$4)`,[scope,n<=4?'kol':'portfolio_wallet',a,new Date(baseTime-10*86400000)]);
    await query(`INSERT INTO fresh.financial_events VALUES($1,$2,$3,'buy',true,true,900,$4,'100')`,['public-'+n,a,token,new Date(baseTime-8*3600000)]);
    await query(`INSERT INTO fresh.positions VALUES($1,$2,'0.5',999,$3,$4,$5,'1/2','matched',1)`,
      [scope,token,hash(999),new Date(baseTime-11000),new Date(baseTime-8*3600000)]);
  }
}
async function eligibilityTests(){
  await seedEligibility();
  const read=()=>readTokenPostCandidates(pool,{now:baseTime});
  const evidence=(await read()).candidates[0];
  check(evidence?.kolCount===4,'Four public positive holders qualify, excluding private-only fifth wallet');
  check(evidence.participants[0].twitterUsername==='public_creator1','X identities come from the public KOL profile');
  check(evidence.marketCapUsd===null&&evidence.marketVolumeUsd===null,'Missing all financial metrics does not block holding eligibility');
  check(await tokenPostEvidenceIsCanonical(pool,evidence),'Frozen holder evidence validates with real PostgreSQL');
  check(evidence.holdingProofs?.every(p=>p.balance==='0.5'),'Partial holdings remain positive long after the buy');
  await query('UPDATE published_kols SET twitter=$1 WHERE address=$2',['@PUBLIC_CREATOR1',address(4)]);
  check(!(await read()).candidates.length,'Four wallets from only three recorded KOL identities do not qualify');
  check(!await tokenPostEvidenceIsCanonical(pool,evidence),'An identity change invalidates an obsolete holder count');
  await query('UPDATE published_kols SET twitter=$1 WHERE address=$2',['public_creator4',address(4)]);
  await query('UPDATE fresh.kols SET is_tracked=true WHERE wallet_address=$1',[address(5)]);
  await query("UPDATE fresh.accounting_scopes SET kind='kol' WHERE id=$1",['kol:'+address(5)]);
  await query('UPDATE published_kols SET twitter=$1 WHERE address=$2',['https://x.com/PUBLIC_CREATOR1',address(5)]);
  const linked=(await read()).candidates[0];
  check(linked?.kolCount===4&&linked.holdingProofs?.length===5,'Five holding wallets from four KOLs keep every proof while counting the identity once');
  check(await tokenPostEvidenceIsCanonical(pool,linked),'Multiple-wallet canonical evidence revalidates without counting duplicate identities');
  await query('UPDATE fresh.kols SET is_tracked=false WHERE wallet_address=$1',[address(5)]);
  await query("UPDATE fresh.accounting_scopes SET kind='portfolio_wallet' WHERE id=$1",['kol:'+address(5)]);
  await query(`UPDATE fresh.positions SET balance_quantity='0.000000000000000001',quantity_q='1/1000000000000000000' WHERE scope_id=$1`,['kol:'+address(1)]);
  check((await read()).candidates[0]?.kolCount===4,'One raw unit qualifies without floating-point rounding or minimum size');
  await query(`UPDATE fresh.positions SET balance_quantity='0',quantity_q='0' WHERE scope_id=$1`,['kol:'+address(1)]);
  check(!(await read()).candidates.length,'A full exit reduces the four public holders to three');
  await query(`UPDATE fresh.positions SET balance_quantity='0.5',quantity_q='1/2' WHERE scope_id=$1`,['kol:'+address(1)]);
  await query(`UPDATE fresh.financial_events SET kind='transfer_in' WHERE id='public-1'`);
  check(!(await read()).candidates.length,'Airdrop/transfer-only positive inventory does not count as a KOL buyer');
  await query(`UPDATE fresh.financial_events SET kind='buy' WHERE id='public-1'`);
  await query(`UPDATE fresh.positions SET quantity_q='1/3' WHERE scope_id=$1`,['kol:'+address(1)]);
  check(!(await read()).candidates.length,'Contradictory confirmed and ledger quantities do not qualify');
  await query(`UPDATE fresh.positions SET quantity_q='1/2' WHERE scope_id=$1`,['kol:'+address(1)]);
  await query('INSERT INTO fresh.recent_evidence VALUES(ARRAY[$1::text],1000,$2)',[address(1),'pending']);
  check(!(await read()).candidates.length,'An undecoded receipt after balance verification prevents an outdated positive holding');
  await query('DELETE FROM fresh.recent_evidence');
  await query('UPDATE fresh.wallets SET decode_gap_from_block=1000 WHERE address=$1',[address(1)]);
  check(!(await read()).candidates.length,'Uncaptured later wallet activity blocks current ownership approval');
  await query('UPDATE fresh.wallets SET decode_gap_from_block=800 WHERE address=$1',[address(1)]);
  check((await read()).candidates[0]?.kolCount===4,'A historical gap before the independent balance proof does not block known holdings');
  await query('UPDATE fresh.wallets SET decode_gap_from_block=NULL');
  await query('UPDATE fresh.positions SET revision=2 WHERE scope_id=$1',['kol:'+address(1)]);
  check(!await tokenPostEvidenceIsCanonical(pool,evidence),'A position correction invalidates a prepared holding proof');
  await query('UPDATE fresh.positions SET revision=1');
  await query('UPDATE fresh.recent_blocks SET block_hash=$1 WHERE block_number=999',[hash(9999)]);
  check(!(await read()).candidates.length,'An orphaned balance block cannot count a holder');
  await query('UPDATE fresh.recent_blocks SET block_hash=$1 WHERE block_number=999',[hash(999)]);
  await query(`UPDATE fresh.tokens SET market_cap_usd=1,price_source='node',valuation_status='ready',total_supply_raw=1000000,
    decimals=18,observed_at=$1,observed_block=999,observed_hash=$2`,[new Date(baseTime-11000),hash(999)]);
  check((await read()).candidates[0]?.marketCapUsd==='1','A verified $1 market cap is display data, with no minimum threshold');
  await query(`UPDATE fresh.tokens SET observed_at=$1`,[new Date(baseTime-600000)]);
  check((await read()).candidates[0]?.marketCapUsd===null,'Stale market cap disappears without rejecting current holders');
  check((await readTokenPostCandidates(pool,{now:baseTime+120001})).reason==='indexer_lag','Stale capture remains a hard stop');
  check(!await tokenPostEvidenceIsCanonical(pool,{...evidence,version:1}),'Old hourly-trader evidence cannot be dispatched');
  const job=randomUUID();await query('INSERT INTO x_token_post_jobs(id,token_address,evidence)VALUES($1,$2,$3)',[job,token,evidence]);
  check(!(await readTokenPostCandidates(pool,{now:baseTime,discovery:true})).candidates.length,'Discovery does not repeatedly select existing queued jobs');
  check((await readTokenPostCandidates(pool,{now:baseTime,discovery:true,token})).candidates.length===1,'Explicit preview can inspect an existing queued token');
  await query(`UPDATE x_token_post_jobs SET status='deferred'`);
  check((await readTokenPostCandidates(pool,{now:baseTime,discovery:true})).candidates.length===1,'Deferred never-sent tokens can qualify again');
  return (await read()).candidates[0];
}

function createRig(template: TokenPostEvidence) {
  let time = baseTime, active = true, valid = true, sequence = 0, uploadCount = 0, publishCount = 0, prepareCount = 0, reconcileCount = 0;
  let cardFailures = 0, narrativeFailures = 0, throwingLog = false, exitOnUpload = false;
  let items = [template];
  const fresh = (evidence: TokenPostEvidence): TokenPostEvidence => ({ ...evidence, evaluatedAt: new Date(time - 10_000).toISOString(),
    quoteObservedAt: new Date(time - 11_000).toISOString(), windowStart: new Date(time - 3_610_000).toISOString() });
  let publishImpl: XTokenPostTransport['publish'] = async () => ({ postId: String(++sequence), createdAt: new Date(time).toISOString() });
  let reconcileImpl: XTokenPostTransport['reconcile'] = async () => ({ status: 'not_found' });
  const transport: XTokenPostTransport = {
    verifyAccount: async () => ({ id: '700', username: 'kollens' }),
    uploadPng: async () => { uploadCount++; if(exitOnUpload)active=false; return { mediaId: String(10000 + uploadCount), mediaKey: `3_${10000 + uploadCount}`, expiresAt: new Date(time + 3600_000).toISOString() }; },
    publish: async input => { publishCount++; return publishImpl(input); },
    reconcile: async input => { reconcileCount++; return reconcileImpl(input); },
    fetchOfficialPosts: async () => [],
  };
  const create = (mode: 'disabled' | 'dry_run' | 'live' = 'live') => createXTokenPosts({ db: pool, mode, now: () => time, transport,
    candidates: async () => ({ candidates: items.map(fresh), reason: null, evaluatedAt: new Date(time).toISOString() }),
    revalidate: async (_db, evidence) => active ? fresh(evidence) : null,
    canonical: async () => valid,
    narrative: async () => { prepareCount++; if (narrativeFailures-- > 0) throw new Error('Fake model response lost'); return { narrative: facts, sources: [] }; },
    card: async () => { if (cardFailures-- > 0) throw new Error('Fake image rendering failure'); return Buffer.from('fake-png-local-test'); },
    log: () => { if (throwingLog) throw new Error('Fake diagnostic sink failure'); },
    content: { apiKey: null },
  });
  return { create, setTime: (value: number) => { time = value; }, advance: (ms: number) => { time += ms; }, now: () => time,
    setActive: (value: boolean) => { active = value; }, setValid: (value: boolean) => { valid = value; },
    exitDuringUpload: () => { exitOnUpload = true; },
    setItems: (value: TokenPostEvidence[]) => { items = value; }, setPublish: (fn: XTokenPostTransport['publish']) => { publishImpl = fn; },
    setReconcile: (fn: XTokenPostTransport['reconcile']) => { reconcileImpl = fn; },
    setCardFailures: (value: number) => { cardFailures = value; }, setNarrativeFailures: (value: number) => { narrativeFailures = value; },
    setThrowingLog: (value: boolean) => { throwingLog = value; },
    counts: () => ({ uploadCount, publishCount, prepareCount, reconcileCount }) };
}

async function resetJobs() {
  await pool.query('TRUNCATE x_token_post_attempts,x_token_post_jobs');
  await pool.query('UPDATE x_token_post_settings SET enabled=false,last_sent_at=NULL,last_dispatch_at=NULL,cooldown_until=NULL,account_id=NULL');
}
async function prepared(template: TokenPostEvidence) {
  const rig = createRig(template), service = rig.create(); await service.enable(); await service.collect(); await service.prepareOne();
  return { rig, service };
}

async function durableTests(template: TokenPostEvidence) {
  await resetJobs();
  const rig = createRig(template), a = rig.create(), b = rig.create();
  check((await a.collect()).collected === 0, 'Publishing defaults to disabled');
  await a.enable();
  await Promise.all([a.collect(), b.collect()]);
  check((await jobRows()).length === 1, 'Concurrent collectors coalesce through token/account uniqueness');
  await Promise.all([a.prepareOne(), b.prepareOne()]);
  assert.equal(rig.counts().prepareCount, 1);
  check((await jobRows())[0].status === 'ready', 'One content preparation survives concurrent workers');
  await ensureXTokenPostSchema(pool);
  check((await jobRows())[0].status === 'ready', 'Startup preserves prepared durable work');
  await Promise.all([a.deliverOne(), b.deliverOne()]);
  check(rig.counts().publishCount === 1 && (await jobRows())[0].status === 'sent', 'Only one worker dispatches the published token');
  await b.collect(); await b.prepareOne(); rig.advance(600_000); await b.deliverOne();
  assert.equal(rig.counts().publishCount, 1, 'Restarts and repeated collection cannot publish a token twice');
  check((await pool.query('SELECT count(*)::int n FROM x_token_post_attempts')).rows[0].n === 1, 'Delivery IDs and attempts are durable');

  await resetJobs();
  const paused = await prepared(template);
  await paused.service.pause();
  check(!await paused.rig.create().deliverOne() && paused.rig.counts().publishCount === 0, 'Pause survives restart and blocks pending sends');
  await paused.service.enable(); paused.rig.setActive(false); await paused.service.deliverOne();
  check((await jobRows())[0].status === 'deferred', 'Expired qualification is deferred without consuming publication allowance');
  paused.rig.setActive(true); await paused.service.collect(); await paused.service.prepareOne(); await paused.service.deliverOne();
  check((await jobRows())[0].status === 'sent', 'A deferred token can qualify later');

  await resetJobs();
  const exitedDuringUpload=await prepared(template);exitedDuringUpload.rig.exitDuringUpload();await exitedDuringUpload.service.deliverOne();
  check(exitedDuringUpload.rig.counts().publishCount===0,'A holder exit during media upload cannot publish an obsolete four-holder post');
  check((await jobRows())[0].status==='deferred','Losing the fifth holder defers without consuming the token publication allowance');

  await resetJobs();
  const spacing = createRig(template), spaced = spacing.create();
  spacing.setItems([template, { ...template, token: { ...template.token, address: address(70001) } }]);
  await spaced.enable(); await spaced.collect(); await spaced.prepareOne();
  check(!await spaced.prepareOne() && spacing.counts().prepareCount === 1, 'An existing ready job reserves the next preparation slot');
  await spaced.deliverOne();
  check(!await spaced.deliverOne(), 'Second post is held during ten-minute spacing');
  spacing.advance(599_999); check(!await spacing.create().deliverOne(), 'Spacing is durable across service instances');
  check(!await spacing.create().prepareOne() && spacing.counts().prepareCount === 1, 'Waiting during the spacing window cannot incur additional model preparation');
  spacing.advance(1); await spacing.create().prepareOne(); await spacing.create().deliverOne();
  assert.equal(spacing.counts().publishCount, 2);

  await resetJobs();
  const dailyRig = createRig(template), daily = { rig: dailyRig, service: dailyRig.create() };
  daily.rig.setTime(Date.parse('2026-10-20T00:30:00Z')); await daily.service.enable(); await daily.service.collect();
  for (let n = 1; n <= 12; n++) await pool.query(`INSERT INTO x_token_post_jobs(id,token_address,evidence,status,post_id,sent_at,dispatch_started_at)
    VALUES($1,$2,$3,'sent',$4,'2026-10-19T22:05:00Z','2026-10-19T22:05:00Z')`, [randomUUID(), address(80000 + n), template, `seed-${n}`]);
  check(!await daily.service.deliverOne(), 'Twelve posts from the same Skopje day block the next slot despite a different UTC date');
  check(!await daily.service.prepareOne() && daily.rig.counts().prepareCount === 0, 'Exhausting the daily publication budget prevents model preparation charges');
  daily.rig.setTime(Date.parse('2026-10-20T22:05:00Z'));
  await daily.rig.create().prepareOne(); await daily.rig.create().deliverOne();
  check(daily.rig.counts().publishCount === 1, 'Daily budget resets at Skopje midnight');

  await resetJobs();
  const reservedQuota = await prepared(template);
  for (let n = 1; n <= 11; n++) await pool.query(`INSERT INTO x_token_post_jobs(id,token_address,evidence,status,post_id,sent_at,dispatch_started_at)
    VALUES($1,$2,$3,'sent',$4,$5,$5)`, [randomUUID(), address(82000 + n), template, `quota-${n}`, new Date(baseTime - 3_600_000).toISOString()]);
  await pool.query(`INSERT INTO x_token_post_jobs(id,token_address,evidence,status,dispatch_started_at,needs_inspection)
    VALUES($1,$2,$3,'uncertain',$4,true)`, [randomUUID(), address(83000), template, new Date(baseTime - 3_600_000).toISOString()]);
  check(!await reservedQuota.service.deliverOne() && reservedQuota.rig.counts().publishCount === 0,
    'An uncertain send reserves its daily quota until reconciled');

  await resetJobs();
  const imageRetry = createRig(template), imageService = imageRetry.create();
  imageRetry.setCardFailures(1); await imageService.enable(); await imageService.collect(); await imageService.prepareOne();
  const failedImage = (await jobRows())[0];
  check(failedImage.status === 'pending' && failedImage.content_started_at && failedImage.narrative,
    'Narrative attempt and result survive a later image failure');
  imageRetry.advance(60_000); await imageRetry.create().prepareOne();
  check(imageRetry.counts().prepareCount === 1 && (await jobRows())[0].status === 'ready',
    'Restart retries image preparation without another narrative/model attempt');
  await imageRetry.create().deliverOne(); assert.equal(imageRetry.counts().publishCount, 1);

  await resetJobs();
  const lostNarrative = createRig(template), lostService = lostNarrative.create();
  lostNarrative.setNarrativeFailures(1); await lostService.enable(); await lostService.collect(); await lostService.prepareOne();
  check((await jobRows())[0].content_started_at && !(await jobRows())[0].narrative, 'A potentially billed model request reserves its one allowed attempt');
  lostNarrative.advance(60_000); await lostNarrative.create().prepareOne();
  check(lostNarrative.counts().prepareCount === 1 && (await jobRows())[0].narrative.reason === 'model_unavailable',
    'A lost model response uses the facts-only fallback after restart without resubmitting');

  await resetJobs();
  const logged = createRig(template), loggingService = logged.create(); logged.setThrowingLog(true);
  await loggingService.enable(); await loggingService.collect(); await loggingService.prepareOne();
  check((await jobRows())[0].status === 'ready', 'A failed diagnostic sink cannot undo ready preparation');
  await loggingService.deliverOne(); logged.advance(600_000); await logged.create().collect(); await logged.create().deliverOne();
  check((await jobRows())[0].status === 'sent' && logged.counts().publishCount === 1, 'Throwing post-send diagnostics cannot trigger resubmission');

  await resetJobs();
  const rejected = await prepared(template);
  rejected.rig.setPublish(async () => { throw new XTokenPostTransportError('rejected', 'invalid_publication'); });
  await rejected.service.deliverOne();
  check((await jobRows())[0].status === 'failed', 'Definite provider rejection remains a terminal failed job');
  rejected.rig.advance(600_000); const recollected = await rejected.rig.create().collect();
  check(recollected.collected === 0 && !await rejected.rig.create().prepareOne() && !await rejected.rig.create().deliverOne()
    && rejected.rig.counts().publishCount === 1, 'Collection never revives rejected work even if a candidate source returns it again');

  await resetJobs();
  const cooling = await prepared(template), resumeAt = cooling.rig.now() + 180_000;
  cooling.rig.setThrowingLog(true);
  cooling.rig.setPublish(async () => { throw new XTokenPostTransportError('cooldown', 'rate_limited', new Date(resumeAt).toISOString()); });
  await cooling.service.deliverOne();
  check((await jobRows())[0].status === 'ready', 'Definite provider cooldown preserves ready work without an ambiguous state');
  check(!await cooling.rig.create().deliverOne(), 'Provider cooldown is shared across restarted workers');
  cooling.rig.advance(600_000);
  cooling.rig.setPublish(async () => ({ postId: 'cooldown-recovered', createdAt: new Date(cooling.rig.now()).toISOString() }));
  await cooling.rig.create().deliverOne();
  check((await jobRows())[0].post_id === 'cooldown-recovered', 'Cooldown resumes the same durable token job');

  await resetJobs();
  const ambiguous = await prepared(template);
  ambiguous.rig.setPublish(async () => { throw new XTokenPostTransportError('ambiguous', 'delivery_unknown'); });
  await ambiguous.service.deliverOne();
  check((await jobRows())[0].status === 'uncertain', 'A post-send timeout never becomes a retryable ready job');
  ambiguous.rig.advance(600_000); await ambiguous.rig.create().deliverOne();
  assert.equal(ambiguous.rig.counts().publishCount, 1, 'Ambiguous sends are not blindly retried');
  ambiguous.rig.setReconcile(async () => ({ status: 'found', postId: 'reconciled-message', createdAt: new Date(ambiguous.rig.now() - 600_000).toISOString() }));
  await ambiguous.rig.create().reconcileOne();
  check((await jobRows())[0].post_id === 'reconciled-message', 'Timeline reconciliation records the original post ID');
  assert.equal(ambiguous.rig.counts().publishCount, 1);

  await resetJobs();
  const unresolved = await prepared(template);
  unresolved.rig.setPublish(async () => { throw new XTokenPostTransportError('ambiguous', 'delivery_unknown'); });
  await unresolved.service.deliverOne(); unresolved.rig.advance(120_000); await unresolved.rig.create().reconcileOne();
  const inspected = (await jobRows())[0];
  check(inspected.status === 'uncertain' && inspected.needs_inspection, 'Absent timeline matches are retained for inspection');
  unresolved.rig.advance(86_400_000); await unresolved.rig.create().deliverOne();
  assert.equal(unresolved.rig.counts().publishCount, 1, 'An inconclusive timeline scan never authorizes an automatic resend');

  await resetJobs();
  const interrupted = await prepared(template);
  await pool.query(`UPDATE x_token_post_jobs SET status='sending',lease_id=$1,lease_until=$2,dispatch_started_at=$3,
    caption='possibly sent',media_id='9',media_key='3_9'`, [randomUUID(), new Date(interrupted.rig.now() - 1), new Date(interrupted.rig.now() - 1000)]);
  await interrupted.rig.create().deliverOne();
  check((await jobRows())[0].status === 'uncertain', 'Expired sending leases become uncertain after a crash');
  check(interrupted.rig.counts().publishCount === 0, 'Restart never repeats an in-flight send');

  await resetJobs();
  const orphan = await prepared(template);
  await rollbackXTokenPosts(pool, 1000);
  check((await jobRows())[0].status === 'cancelled', 'Reorg cancels unpublished dependent work');
  await orphan.service.deliverOne(); assert.equal(orphan.rig.counts().publishCount, 0);
  await resetJobs();
  const delivered = await prepared(template); await delivered.service.deliverOne();
  await rollbackXTokenPosts(pool, 1000);
  const orphanedDelivery = (await jobRows())[0];
  check(orphanedDelivery.status === 'sent' && orphanedDelivery.needs_inspection && orphanedDelivery.post_id, 'Reorg preserves delivery evidence and flags published posts');

  await resetJobs();
  const dry = createRig(template), preview = dry.create('dry_run');
  await preview.collect({ force: true }); await preview.prepareOne(true);
  check(!await preview.deliverOne() && dry.counts().publishCount === 0, 'Dry run prepares persisted previews without any X send');
  const previewResult = await preview.preview();
  const previewCaption = previewResult.items[0].caption;
  check(previewCaption.endsWith(`\n\nCA: ${template.token.address}\nhttps://kollens.com`)
    && JSON.stringify(twitterText.extractUrls(previewCaption)) === JSON.stringify(['https://kollens.com']),
  'Prepared captions preserve the full CA and exactly one trusted website footer');
}

try {
  await ensureXTokenPostSchema({query: async (sql: string) => query(sql.replaceAll('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE IF NOT EXISTS'))} as unknown as Pick<Pool,'query'>);
  const fixture = await eligibilityTests();
  await durableTests(fixture);
  console.log(JSON.stringify({ suite: 'x-token-posts', assertions, result: 'passed', transports: 'fake-only' }));
} finally { globalThis.fetch = savedFetch; session.release(); await originalPool.end(); }
