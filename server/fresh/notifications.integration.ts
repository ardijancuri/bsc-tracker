/** Fake transport, transaction-rolled-back fixtures. No Telegram requests. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { ensureFreshSchema } from './schema.js';
import { createTelegramNotifications, rollbackTelegramNotifications } from '../telegramNotifications.js';
import {invalidateFreshNotificationActivation} from './notificationActivation.js';
import type { createTelegramBot, TelegramBotConfig, TelegramBotResult, TelegramMessageEntity } from '../telegramBot.js';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.includes('fresh')) throw new Error('Use an isolated local fresh database');
const db = new Pool({ connectionString: url.toString(), max: 2 }), client = await db.connect();
const wallet = `0x${randomBytes(20).toString('hex')}`, privateWallet = `0x${randomBytes(20).toString('hex')}`, token = `0x${randomBytes(20).toString('hex')}`;
const user = randomUUID(), chatId = '9000000000001', config: TelegramBotConfig = { botId: '999999999999', token: '999999999999:fake-only-never-sent', webhookSecret: 'fake-test-webhook-secret', origin: 'https://kollens.com' };
let time = Date.parse('2000-01-01T12:00:00Z'), number = 500, messageId = 0, transactionNumber = 0,identityRequests=0;
const sent: { text: string; edit: boolean; entities?: TelegramMessageEntity[] }[] = [], results: TelegramBotResult[] = [];
const fakeBot: Pick<ReturnType<typeof createTelegramBot>, 'verifyIdentity' | 'send' | 'edit'> = {
  async verifyIdentity() { identityRequests++; return true; },
  async send(_chat, text, _buttons, entities) { sent.push({ text, edit: false, entities }); return results.shift() ?? { kind: 'sent', messageId: ++messageId }; },
  async edit(_chat, id, text, _buttons, entities) { sent.push({ text, edit: true, entities }); return results.shift() ?? { kind: 'sent', messageId: id }; },
};
/** Serialize service connections and map their transaction boundaries to
 * savepoints inside one outer fixture transaction. Production SQL runs as-is. */
let held = false;
const waiting: (() => void)[] = [];
const transactionalDb = {
  query: (sql: string, values?: any[]) => client.query(sql, values),
  async connect() {
    if (held) await new Promise<void>(resolve => waiting.push(resolve)); held = true;
    const savepoint = `notification_fixture_${++transactionNumber}`;
    return { query: (sql: string, values?: any[]) => client.query(sql === 'BEGIN' ? `SAVEPOINT ${savepoint}` : sql === 'COMMIT' ? `RELEASE SAVEPOINT ${savepoint}` : sql === 'ROLLBACK' ? `ROLLBACK TO SAVEPOINT ${savepoint}` : sql, values),
      release() { const next = waiting.shift(); if (next) next(); else held = false; } } as unknown as PoolClient;
  },
} as unknown as Pool;
const make = () => createTelegramNotifications({ db: transactionalDb, bot: fakeBot, config, stateTable: 'fresh.checkpoints', now: () => time }), service = make();
const advance = (ms = 1_100) => { time += ms; };
const date=(ms:number)=>new Date(ms).toISOString();
async function count(table: string, where: string, values: unknown[]) { return Number((await client.query(`SELECT count(*)::int n FROM ${table} WHERE ${where}`, values)).rows[0].n); }
async function trade(input: { wallet?: string; side?: 'buy' | 'sell'; live?: boolean; at?: number; block?: number } = {}) {
  const id = randomUUID(), block = input.block ?? ++number, blockHash = `0x${block.toString(16).padStart(64, '0')}`;
  await client.query(`INSERT INTO fresh.financial_events(id,execution_key,wallet_address,token_address,kind,quantity,amount_usd,fee_usd,fee_key,
    block_number,block_hash,transaction_hash,transaction_index,execution_index,occurred_at,observed_live,quote_symbol,quote_amount)
    VALUES($1,$2,$3,$4,$5,'1000','50','0',$6,$7,$8,$9,0,0,$10,$11,'BNB','0.1')`, [id, `fixture:${id}`, input.wallet ?? wallet, token, input.side ?? 'buy', `fee:${id}`, block, blockHash, `0x${id.replaceAll('-', '').padEnd(64, '0')}`, new Date(input.at ?? time), input.live ?? true]);
  return { id, block, blockHash };
}
try {
  await ensureFreshSchema(db); await client.query('BEGIN');
  await client.query(`INSERT INTO auth_users(id,issuer,subject,name,telegram_id) VALUES($1,'https://oauth.telegram.org',$2,'Fake local test',$3)`, [user, user, chatId]);
  await client.query('INSERT INTO fresh.wallets(address,monitoring_from_block) VALUES($1,1),($2,1)', [wallet, privateWallet]);
  await client.query("INSERT INTO fresh.kols(wallet_address,display_name) VALUES($1,'Fresh KOL')", [wallet]);
  await client.query("INSERT INTO fresh.tokens(address,symbol,name,decimals,launch_status) VALUES($1,'TEST','Fresh token',18,'eligible')", [token]);
  await client.query("INSERT INTO account_watch_entries(user_id,kind,address,added_at) VALUES($1,'kol',$2,$3),($1,'kol',$4,$3)", [user, wallet, new Date(time - 10_000), privateWallet]);
  // No legacy worker_state node row exists. The fresh capture checkpoint is
  // the confirmed collection boundary used by collection and dispatch.
  await client.query("UPDATE fresh.checkpoints SET block_number=1000000 WHERE key='capture'");
  await service.authorize({ userId: user, telegramId: chatId, language: 'en' }); assert.equal((await service.state(user)).enabled, false);
  advance(); assert.equal(await service.deliverOne(), true); assert.equal((await service.state(user)).enabled, true); advance();
  const first = await trade();
  const gathered = await Promise.all([service.collect(), make().collect()]); assert.equal(gathered.reduce((sum, row) => sum + row.recipients, 0), 1);
  assert.equal(await count('telegram_trade_events', 'trade_id=$1', [first.id]), 1); assert.equal(await count('telegram_notification_items', 'user_id=$1 AND trade_id=$2', [user, first.id]), 1);
  assert.equal((await client.query('SELECT telegram_notification_processed FROM fresh.financial_events WHERE id=$1', [first.id])).rows[0].telegram_notification_processed, true);
  assert.equal(await service.deliverOne(), true); assert.match(sent.at(-1)!.text, /TEST/); assert.ok(sent.at(-1)!.entities?.some(entity => entity.type === 'bold'));
  advance(100); const burst1 = await trade(), burst2 = await trade({ side: 'sell' }); await service.collect(); assert.equal(await service.deliverOne(), false); advance(10_001); assert.equal(await service.deliverOne(), true);
  assert.match(sent.at(-1)!.text, /🟢.*buy/); assert.match(sent.at(-1)!.text, /🔴.*sell/);
  // Private wallets, historical imports, transfers and transactions beyond the
  // committed capture checkpoint cannot become public KOL alerts.
  const privateTrade = await trade({ wallet: privateWallet }), historical = await trade({ live: false }), unconfirmed = await trade({ block: 1_000_001 });
  await service.collect();
  for (const id of [privateTrade.id, historical.id, unconfirmed.id]) assert.equal(await count('telegram_trade_events', 'trade_id=$1', [id]), 0);
  // Mute/unmute boundaries and pause never backfill older trades.
  await service.mute(user, wallet, true); advance(); const muted = await trade(); await service.collect(); assert.equal(await count('telegram_trade_events', 'trade_id=$1', [muted.id]), 0);
  advance(); await service.mute(user, wallet, false); const beforeUnmute = await trade({ at: time - 1 }); await service.collect(); assert.equal(await count('telegram_trade_events', 'trade_id=$1', [beforeUnmute.id]), 0);
  advance(); const pending = await trade(); await service.collect(); await service.update(user, { enabled: false }); assert.equal(await service.deliverOne(), false);
  assert.equal(await count('telegram_notification_items', 'user_id=$1 AND trade_id=$2 AND cancelled', [user, pending.id]), 1);
  advance(); await service.update(user, { enabled: true }); const beforeResume = await trade({ at: time - 1 }); await service.collect(); assert.equal(await count('telegram_trade_events', 'trade_id=$1', [beforeResume.id]), 0);
  // Returned message IDs/delivery evidence survive canonical trade invalidation.
  await rollbackTelegramNotifications(client, first.block); await client.query('UPDATE fresh.financial_events SET canonical=false WHERE id=ANY($1::text[])', [[first.id, burst1.id, burst2.id]]);
  assert.equal(await count('telegram_trade_events', 'trade_id=$1 AND orphaned', [first.id]), 1); assert.equal(await count('telegram_notification_items', 'user_id=$1 AND trade_id=$2', [user, first.id]), 1);
  assert.ok(await count('telegram_notification_outbox', "user_id=$1 AND kind='correction'", [user]));
  // queueCorrections intentionally uses the database clock in production;
  // bring only our fixture jobs into the controlled test clock's time domain.
  await client.query("UPDATE telegram_notification_outbox SET due_at=$2,created_at=$2 WHERE user_id=$1 AND kind='correction'", [user, new Date(time)]);
  advance(10_000); await service.deliverOne(); assert.equal(sent.at(-1)!.edit, true);
  // A separate production cutover must not deliver imported pending work or
  // replay pre-handoff trades under Fresh's different event identities.
  const production=createTelegramNotifications({db:transactionalDb,bot:fakeBot,config,stateTable:'fresh.checkpoints',now:()=>time,productionActivation:{enabled:true}});
  const sentBefore=sent.length,identityBefore=identityRequests;
  assert.deepEqual(await production.collect(),{events:0,recipients:0});assert.equal(await production.deliverOne(),false);assert.equal(identityRequests,identityBefore);
  const activatedAt=date(time),floor=1000,floorHash='0x'+floor.toString(16).padStart(64,'0'),sourceManifestSha256='a'.repeat(64);
  await client.query(`INSERT INTO fresh.recent_blocks(block_number,block_hash,parent_hash,occurred_at) VALUES($1,$2,$3,$4)`,[floor,floorHash,'0x'+'0'.repeat(64),activatedAt]);
  await client.query(`INSERT INTO fresh.checkpoints(key,value) VALUES('production_cutover_seal',$1::jsonb)`,[JSON.stringify({version:1,sealedAt:date(time-1),sourceManifestSha256,legacyPendingCount:0,legacyLeasedCount:0,legacySenderStoppedAcknowledged:true,legacyCollectorStoppedAcknowledged:true,legacyUnprocessedCount:0,legacyBotSendingCount:0,legacyHandoffBlock:String(floor),legacyHandoffHash:floorHash})]);
  await client.query(`INSERT INTO fresh.checkpoints(key,block_number,block_hash,value) VALUES('production_activation',$1,$2,$3::jsonb)`,[floor,floorHash,JSON.stringify({version:1,activatedAt,alertStartBlock:String(floor),alertStartHash:floorHash,sourceManifestSha256})]);
  const imported=randomUUID(),importedLeased=randomUUID();
  await client.query(`INSERT INTO telegram_notification_outbox(id,user_id,chat_id,kind,language,due_at,created_at,status,lease_id,lease_until)
    VALUES($1,$3,$4,'status','en',$5,$5,'pending',NULL,NULL),($2,$3,$4,'status','en',$5,$5,'leased',$6,$5)`,[imported,importedLeased,user,chatId,date(time-1),randomUUID()]);
  const retainedOld=(await client.query('SELECT * FROM telegram_notification_outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[[imported,importedLeased]])).rows;
  advance(1100);const beforeFloor=await trade({block:999}),atFloor=await trade({block:1000}),afterFloor=await trade({block:1001});
  const collected=await production.collect();assert.equal(collected.recipients,1);
  for(const e of[beforeFloor,atFloor])assert.equal(await count('telegram_trade_events','trade_id=$1',[e.id]),0);
  assert.equal(await count('telegram_trade_events','trade_id=$1',[afterFloor.id]),1);assert.equal(await production.deliverOne(),true);assert.equal(sent.length,sentBefore+1);
  assert.deepEqual((await client.query('SELECT * FROM telegram_notification_outbox WHERE id=ANY($1::uuid[]) ORDER BY id',[[imported,importedLeased]])).rows,retainedOld);
  // Invalidate after the claim commits but before dispatch preparation. All
  // non-trade job kinds must remain unsent and release their lease.
  await client.query("UPDATE telegram_notification_outbox SET status='cancelled' WHERE user_id=$1 AND status='pending' AND id<>$2",[user,imported]);
  for(const kind of ['status','correction','activation']){
    advance(1100);
    await client.query("UPDATE fresh.checkpoints SET value=value-'invalidatedAt'-'reason' WHERE key='production_activation'");
    const raceId=randomUUID();
    await client.query("UPDATE telegram_notification_settings SET connection=$2 WHERE user_id=$1",[user,kind==='activation'?'pending':'connected']);
    await client.query(`INSERT INTO telegram_notification_outbox(id,user_id,chat_id,kind,language,generation,due_at,created_at)
      SELECT $1,user_id,chat_id,$3,'en',generation,$4,$4 FROM telegram_notification_settings WHERE user_id=$2`,[raceId,user,kind,date(time)]);
    let connections=0;
    const raceDb={query:transactionalDb.query.bind(transactionalDb),async connect(){if(++connections===2)await invalidateFreshNotificationActivation(client,999,new Date(time));return transactionalDb.connect();}} as unknown as Pool;
    const raceService=createTelegramNotifications({db:raceDb,bot:fakeBot,config,stateTable:'fresh.checkpoints',now:()=>time,productionActivation:{enabled:true}});
    const sentAtClaim=sent.length;assert.equal(await raceService.deliverOne(),true);assert.equal(connections,2);assert.equal(sent.length,sentAtClaim);
    const job=(await client.query('SELECT status,lease_id,dispatch_started_at,last_error FROM telegram_notification_outbox WHERE id=$1',[raceId])).rows[0];
    assert.deepEqual(job,{status:'pending',lease_id:null,dispatch_started_at:null,last_error:'activation_invalidated'});
    await client.query("UPDATE telegram_notification_outbox SET status='cancelled' WHERE id=$1",[raceId]);
  }
  await invalidateFreshNotificationActivation(client,999,new Date(time));assert.equal(await production.deliverOne(),false);assert.deepEqual(await production.collect(),{events:0,recipients:0});
  const invalid=(await client.query("SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='production_activation'")).rows[0];assert.equal(invalid.block_number,String(floor));assert.equal(invalid.block_hash,floorHash);assert.equal(invalid.value.reason,'activation_block_reorged');
  console.log(JSON.stringify({ ok: true, checks: ['fresh_committed_checkpoint', 'compact_view_update_locking', 'fake_activation_confirmation', 'concurrent_collection_deduplication', 'buy_sell_burst', 'private_isolation', 'historical_silence', 'unconfirmed_silence', 'mute_unmute', 'pause_resume', 'reorg_correction_identity','production_seal_required','no_pre_activation_network','strict_block_handoff','imported_outbox_preserved_silent','post_claim_activation_invalidation','activation_reorg_invalidation'], fakeMessages: sent.length, fixtureWrites: 'rolled back', realTelegramRequests: 0 }));
} finally { await client.query('ROLLBACK'); client.release(); await db.end(); }
