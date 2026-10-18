// Destructive integration suite: explicitly supply a disposable notifications test database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, pool } from './db.js';
import { createTelegramNotifications, rollbackTelegramNotifications } from './telegramNotifications.js';
import { ensureTelegramNotificationsSchema } from './telegramNotificationsSchema.js';
import type { createTelegramBot, TelegramBotConfig, TelegramBotResult, TelegramMessageButton, TelegramMessageEntity } from './telegramBot.js';

let databaseName = '';
try { databaseName = new URL(process.env.DATABASE_URL || '').pathname; } catch { /* Fail closed before any SQL. */ }
if (!/^\/bscan_notifications_test(?:_\d+)?$/.test(databaseName)) throw new Error('Use a disposable bscan_notifications_test database');

const config: TelegramBotConfig = { botId: '12345', token: '12345:test-only-no-real-telegram-credential', origin: 'https://kollens.com', webhookSecret: 'test-only-webhook-secret' };
const kol = `0x${'a'.repeat(40)}`, otherKol = `0x${'d'.repeat(40)}`, token = `0x${'b'.repeat(40)}`;
const reward = '0x21caef8a43163eea865baee23b9c2e327696a3bf';
const uuidA = '11111111-1111-4111-8111-111111111111', uuidB = '22222222-2222-4222-8222-222222222222';
type Sent = { chatId: string; text: string; edit: boolean; messageId: number | null; buttons?: TelegramMessageButton[][]; entities?: TelegramMessageEntity[] };
let testCount = 0;

async function fixture() {
  await pool.query(`TRUNCATE auth_users,trades,kols,tokens,worker_state,telegram_trade_events,
    telegram_notification_outbox,telegram_notification_pacing,telegram_notification_updates CASCADE`);
  let time = Date.now() + 1000, block = 100;
  const sent: Sent[] = [], results: TelegramBotResult[] = [];
  let messageId = 100, identityValid = true;
  let onSend: (() => Promise<void>) | null = null;
  const fakeBot: Pick<ReturnType<typeof createTelegramBot>, 'verifyIdentity' | 'send' | 'edit'> = {
    verifyIdentity: async () => identityValid,
    send: async (chatId, text, buttons, entities) => {
      sent.push({ chatId, text, buttons, entities, edit: false, messageId: null });
      if (onSend) await onSend();
      return results.shift() ?? { kind: 'sent', messageId: ++messageId };
    },
    edit: async (chatId, originalId, text, buttons, entities) => {
      sent.push({ chatId, text, buttons, entities, edit: true, messageId: originalId });
      return results.shift() ?? { kind: 'sent', messageId: originalId };
    },
  };
  const makeService = () => createTelegramNotifications({ db: pool, config, bot: fakeBot, now: () => time });
  const service = makeService();
  await pool.query(`INSERT INTO auth_users(id,issuer,subject,name,telegram_id) VALUES
    ($1,'https://oauth.telegram.org','one','One','10001'),($2,'https://oauth.telegram.org','two','Two','10002')`, [uuidA, uuidB]);
  await pool.query(`INSERT INTO kols(address,display_name,is_tracked) VALUES($1,'Test KOL',true),($2,'Other KOL',true)`, [kol, otherKol]);
  await pool.query(`INSERT INTO tokens(address,symbol,name,decimals,is_meme) VALUES($1,'TEST','Test token',18,true),($2,'XAUt','Reward asset',18,false)`, [token, reward]);
  await pool.query(`INSERT INTO worker_state(key,value) VALUES('node','{"blockNumber":1000000}'::jsonb)`);
  const advance = (ms = 1000) => { time += ms; };
  async function favorite(userId = uuidA, wallet = kol, addedAt = time - 10_000) {
    await pool.query(`INSERT INTO account_watch_entries(user_id,kind,address,added_at) VALUES($1,'kol',$2,$3)
      ON CONFLICT DO NOTHING`, [userId, wallet, new Date(addedAt)]);
  }
  async function activate(userId = uuidA, chatId = '10001') {
    await service.authorize({ userId, telegramId: chatId, language: 'en' });
    assert.equal((await service.state(userId)).connection, 'pending');
    assert.equal((await service.state(userId)).enabled, false, 'Consent alone must not enable delivery');
    advance();
    assert.equal(await service.deliverOne(), true);
    assert.equal((await service.state(userId)).connection, 'connected');
    assert.equal((await service.state(userId)).enabled, true);
    advance();
  }
  async function trade(input: { id?: string; side?: 'buy' | 'sell'; timestamp?: number; observed?: boolean; blockNumber?: number; blockHash?: string; wallet?: string; token?: string } = {}) {
    const id = input.id ?? randomUUID();
    const number = input.blockNumber ?? ++block;
    const hash = input.blockHash ?? `0x${number.toString(16).padStart(64, '0')}`;
    await pool.query(`INSERT INTO trades(id,tx_hash,wallet_address,token_address,side,token_amount,quote_amount,quote_symbol,amount_usd,
      block_number,block_hash,transaction_index,timestamp,source,observed_live)
      VALUES($1,$2,$3,$4,$5,1000,0.1,'BNB',50,$6,$7,0,$8,'node',$9)`,
    [id, `0x${id.replace(/-/g, '').padEnd(64, '0').slice(0, 64)}`, input.wallet ?? kol, input.token ?? token, input.side ?? 'buy', number, hash, new Date(input.timestamp ?? time), input.observed ?? true]);
    return { id, number, hash };
  }
  const count = async (table: string, condition = 'true', params: unknown[] = []) => Number((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${condition}`, params)).rows[0].count);
  const tradeMessages = () => sent.filter(message => !message.edit && message.entities?.some(entity => entity.type === 'text_link' && entity.url?.includes('/token/')));
  async function drain(limit = 30) { for (let i = 0; i < limit; i++) { advance(); if (!await service.deliverOne()) break; } }
  return { service, makeService, sent, results, advance, favorite, activate, trade, count, tradeMessages, drain, now: () => time,
    setIdentity: (value: boolean) => { identityValid = value; }, setOnSend: (callback: (() => Promise<void>) | null) => { onSend = callback; } };
}

async function scenario(name: string, run: (data: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const data = await fixture();
  await run(data); testCount++; console.log(`PASS ${name}`);
}

try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await ensureSchema();

  await scenario('activation is committed only after successful delivery; failed and unavailable activation stays disabled', async f => {
    await f.favorite();
    await f.activate();
    assert.equal(f.sent.length, 1);
    await f.service.authorize({ userId: uuidB, telegramId: '10002', language: 'zh-CN' });
    f.results.push({ kind: 'failed', reason: 'message_rejected' }); f.advance();
    await f.service.deliverOne();
    assert.equal((await f.service.state(uuidB)).connection, 'error');
    assert.equal((await f.service.state(uuidB)).enabled, false);
    await f.service.authorize({ userId: uuidB, telegramId: '10002', language: 'en' });
    f.setIdentity(false); await f.service.deliverOne();
    assert.equal((await f.service.state(uuidB)).enabled, false);
  });

  await scenario('two accounts receive their own favorite trades and concurrent collection remains idempotent', async f => {
    await f.favorite(uuidA); await f.favorite(uuidB); await f.activate(uuidA); await f.activate(uuidB, '10002');
    await f.trade();
    const collected = await Promise.all([f.service.collect(), f.makeService().collect(), f.service.collect()]);
    assert.equal(collected.reduce((n, row) => n + row.recipients, 0), 2);
    assert.equal(await f.count('telegram_trade_events'), 1); assert.equal(await f.count('telegram_notification_items'), 2);
    await f.drain();
    assert.deepEqual(f.tradeMessages().map(message => message.chatId).sort(), ['10001', '10002']);
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='sent'"), 2);
  });

  await scenario('first alert is immediate and subsequent ten-second burst retains buys and sells separately', async f => {
    await f.favorite(); await f.activate(); await f.trade(); await f.service.collect();
    await f.service.deliverOne(); assert.equal(f.tradeMessages().length, 1);
    f.advance(100); await f.trade(); await f.trade({ side: 'sell' }); await f.trade(); await f.service.collect();
    assert.equal(await f.service.deliverOne(), false);
    assert.equal(f.tradeMessages().length, 1);
    f.advance(10_000); await f.service.deliverOne();
    assert.equal(f.tradeMessages().length, 2);
    assert.match(f.tradeMessages()[1].text, /🟢 2 buys · 🔴 1 sells/);
    assert.match(f.tradeMessages()[1].text, /🟢 BUYS\nTEST/); assert.match(f.tradeMessages()[1].text, /🔴 SELLS\nTEST/);
    const message = f.tradeMessages()[1];
    assert.ok(message.entities?.some(entity => entity.type === 'bold' && message.text.slice(entity.offset, entity.offset + entity.length) === 'TEST'));
    assert.ok(message.entities?.some(entity => entity.type === 'text_link' && entity.url?.startsWith('https://kollens.com/token/')));
    assert.doesNotMatch(JSON.stringify(message), /bscscan/i);
    assert.equal(await f.count('telegram_notification_items'), 4, 'Every grouped trade remains durable');
  });

  await scenario('an expired burst cannot absorb later events while delivery waits', async f => {
    await f.favorite(); await f.activate(); await f.trade(); await f.service.collect(); await f.service.deliverOne();
    f.advance(100); await f.trade(); await f.service.collect();
    f.advance(10_001); await f.trade(); await f.service.collect();
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='pending'"), 2, 'Fixed windows must survive cooldowns or delayed dispatch');
  });

  await scenario('activation, favorite, mute, unmute and re-add boundaries do not replay older trades', async f => {
    await f.activate();
    await f.trade({ timestamp: f.now() - 50_000 }); await f.service.collect();
    assert.equal(await f.count('telegram_notification_items'), 0);
    await f.favorite(uuidA, kol, f.now());
    await f.trade({ timestamp: f.now() - 1 }); await f.service.collect(); assert.equal(await f.count('telegram_notification_items'), 0);
    f.advance(); await f.trade(); await f.service.collect(); assert.equal(await f.count('telegram_notification_items'), 1);
    await f.service.mute(uuidA, kol, true); await f.trade(); await f.service.collect();
    assert.equal(await f.count('telegram_notification_items'), 1);
    f.advance(); await f.service.mute(uuidA, kol, false);
    await f.trade({ timestamp: f.now() - 1 }); await f.service.collect(); assert.equal(await f.count('telegram_notification_items'), 1);
    f.advance(); await f.trade(); await f.service.collect(); assert.equal(await f.count('telegram_notification_items'), 2);
    const added = (await pool.query('SELECT added_at FROM account_watch_entries WHERE user_id=$1', [uuidA])).rows[0].added_at;
    await f.favorite(uuidA, kol, f.now());
    assert.equal((await pool.query('SELECT added_at FROM account_watch_entries WHERE user_id=$1', [uuidA])).rows[0].added_at.toISOString(), added.toISOString());
    await pool.query('DELETE FROM account_watch_entries WHERE user_id=$1', [uuidA]);
    f.advance(); await f.favorite(uuidA, kol, f.now()); await f.trade({ timestamp: f.now() - 1 }); await f.service.collect();
    assert.equal(await f.count('telegram_notification_items'), 2);
    await f.service.deliverOne(); assert.equal(f.tradeMessages().length, 0, 'Removed and re-added favorite invalidates old pending deliveries');
  });

  await scenario('filters and pause cancel pending work; resume starts at the current boundary', async f => {
    await f.favorite(); await f.activate(); await f.trade(); await f.service.collect();
    await f.service.update(uuidA, { buys: false });
    await f.service.deliverOne(); assert.equal(f.tradeMessages().length, 0);
    f.advance(); await f.trade({ side: 'sell' }); await f.service.collect();
    await f.service.update(uuidA, { enabled: false });
    await f.service.deliverOne(); assert.equal(f.tradeMessages().length, 0);
    f.advance(); await f.service.update(uuidA, { enabled: true }); await f.trade({ side: 'sell', timestamp: f.now() - 1 });
    await f.service.collect(); assert.equal(await f.count('telegram_notification_items', 'NOT cancelled'), 0);
    f.advance(); await f.trade({ side: 'sell' }); await f.service.collect(); await f.drain();
    assert.equal(f.tradeMessages().length, 1); assert.match(f.tradeMessages()[0].text, /SELL TEST/);
  });

  await scenario('historical imports, excluded assets, untracked wallets and uncommitted ranges stay silent', async f => {
    await f.favorite(); await f.activate();
    await f.trade({ observed: false }); await f.trade({ timestamp: f.now() - 300_001 }); await f.trade({ token: reward });
    await pool.query('UPDATE kols SET is_tracked=false WHERE address=$1', [otherKol]);
    await f.favorite(uuidA, otherKol); await f.trade({ wallet: otherKol });
    const withheld = await f.trade({ blockNumber: 1_000_001 });
    await f.service.collect(); assert.equal(await f.count('telegram_notification_items'), 0);
    await pool.query(`UPDATE worker_state SET value='{"blockNumber":1000001}'::jsonb WHERE key='node'`);
    await f.service.collect(); assert.equal(await f.count('telegram_notification_items'), 1);
    assert.equal(await f.count('telegram_trade_events', 'trade_id=$1', [withheld.id]), 1);
    f.advance(300_001); await f.service.deliverOne(); assert.equal(f.tradeMessages().length, 0, 'A pending alert older than five minutes expires');
  });

  await scenario('429 cooldown is durable and honors global pacing without duplicate sends', async f => {
    await f.favorite(); await f.activate(); await f.trade(); await f.service.collect();
    f.results.push({ kind: 'retry', reason: 'rate_limited', retryAfterMs: 15_000 });
    await f.service.deliverOne(); assert.equal(f.tradeMessages().length, 1);
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='pending'"), 1);
    f.advance(14_999); await f.makeService().deliverOne(); assert.equal(f.tradeMessages().length, 1);
    f.advance(1); await f.makeService().deliverOne(); assert.equal(f.tradeMessages().length, 2);
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='sent'"), 1);
  });

  await scenario('blocked chats disable alerts; ambiguous delivery is retained and never blindly retried', async f => {
    await f.favorite(); await f.activate(); await f.trade(); await f.service.collect();
    f.results.push({ kind: 'uncertain', reason: 'timeout' }); await f.service.deliverOne();
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='uncertain'"), 1);
    f.advance(60_000); await f.service.collect(); await f.service.deliverOne(); assert.equal(f.tradeMessages().length, 1);
    await f.trade(); await f.service.collect(); f.results.push({ kind: 'blocked' }); f.advance(10_000); await f.service.deliverOne();
    assert.equal((await f.service.state(uuidA)).connection, 'blocked'); assert.equal((await f.service.state(uuidA)).enabled, false);
    f.advance(); await f.trade(); await f.service.collect();
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='pending'"), 0);
  });

  await scenario('reorg cancels pending events, preserves delivery evidence and edits sent alerts exactly once', async f => {
    await f.favorite(); await f.activate(); const original = await f.trade(); await f.service.collect(); await f.service.deliverOne();
    const pending = await f.trade(); await f.service.collect();
    const client = await pool.connect();
    try { await client.query('BEGIN'); await rollbackTelegramNotifications(client, original.number); await client.query('DELETE FROM trades WHERE block_number>=$1', [original.number]); await client.query('COMMIT'); } finally { client.release(); }
    assert.equal(await f.count('telegram_trade_events', 'orphaned'), 2);
    assert.equal(await f.count('telegram_notification_outbox', "kind='correction'"), 1);
    assert.equal(await f.count('telegram_notification_items', 'trade_id=$1', [pending.id]), 1, 'Evidence survives canonical trade deletion');
    f.advance(); await f.service.deliverOne();
    assert.equal(f.sent.filter(message => message.edit).length, 1);
    assert.match(f.sent.find(message => message.edit)!.text, /Chain correction/);
    const second = await pool.connect(); try { await rollbackTelegramNotifications(second, original.number); } finally { second.release(); }
    assert.equal(await f.count('telegram_notification_outbox', "kind='correction'"), 1);
    f.advance(10_000); await f.trade({ id: original.id, blockHash: `0x${'e'.repeat(64)}` }); await f.service.collect(); await f.service.deliverOne();
    assert.equal(f.tradeMessages().length, 2, 'A re-mined canonical event has its own block-hash identity');
  });

  await scenario('network work holds no database transaction or reorg lock; in-flight orphan gets a correction', async f => {
    await f.favorite(); await f.activate(); const original = await f.trade(); await f.service.collect();
    let sending!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { sending = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setOnSend(async () => { sending(); await gate; });
    const dispatch = f.service.deliverOne(); await started;
    const concurrent = await f.makeService().deliverOne(); assert.equal(concurrent, false, 'Another worker cannot dispatch the leased chat');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='2s'");
      await client.query('SELECT pg_advisory_xact_lock(782319)'); await rollbackTelegramNotifications(client, original.number);
      await client.query('DELETE FROM trades WHERE id=$1', [original.id]); await client.query('COMMIT');
    } finally { client.release(); release(); }
    await dispatch; f.setOnSend(null);
    assert.equal(await f.count('telegram_notification_outbox', "kind='correction'"), 1);
    f.advance(); await f.service.deliverOne(); assert.equal(f.sent.filter(message => message.edit).length, 1);
  });

  await scenario('deduplicated private /stop pauses without /start automatically enabling again', async f => {
    await f.favorite(); await f.activate(); await f.trade(); await f.service.collect();
    await f.service.webhook({ updateId: '100', telegramId: '10001', command: 'stop' });
    await f.service.webhook({ updateId: '100', telegramId: '10001', command: 'stop' });
    assert.equal((await f.service.state(uuidA)).enabled, false);
    assert.equal(await f.count('telegram_notification_updates'), 1);
    assert.equal(await f.count('telegram_notification_outbox', "kind='status'"), 1);
    await f.service.webhook({ updateId: '101', telegramId: '10001', command: 'start' });
    assert.equal((await f.service.state(uuidA)).enabled, false);
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='pending'"), 0);
  });

  await scenario('API pause and /stop both cancel a pending activation before it can enable alerts', async f => {
    await f.service.authorize({ userId: uuidA, telegramId: '10001', language: 'en' });
    await f.service.update(uuidA, { enabled: false });
    assert.notEqual((await f.service.state(uuidA)).connection, 'pending');
    assert.equal((await f.service.state(uuidA)).enabled, false);
    f.advance(); await f.service.deliverOne(); assert.equal(f.sent.length, 0);
    await f.service.authorize({ userId: uuidA, telegramId: '10001', language: 'en' });
    await f.service.webhook({ updateId: '200', telegramId: '10001', command: 'stop' });
    assert.notEqual((await f.service.state(uuidA)).connection, 'pending');
    assert.equal(await f.count('telegram_notification_outbox', "kind='activation' AND status='pending'"), 0);
    f.advance(); await f.service.deliverOne();
    assert.equal(f.sent.some(message => message.text.includes('alerts are active')), false);
  });

  await scenario('neutral bot membership updates preserve pending and active consent; unblocking still requires reconnect', async f => {
    await f.service.authorize({ userId: uuidA, telegramId: '10001', language: 'en' });
    await f.service.webhook({ updateId: 'membership-pending', telegramId: '10001', command: null, blocked: false });
    assert.equal((await f.service.state(uuidA)).connection, 'pending');
    assert.equal(await f.count('telegram_notification_outbox', "kind='activation' AND status='pending'"), 1);
    f.advance(); await f.service.deliverOne();
    assert.equal((await f.service.state(uuidA)).connection, 'connected');
    assert.equal((await f.service.state(uuidA)).enabled, true);
    await f.service.webhook({ updateId: 'membership-active', telegramId: '10001', command: null, blocked: false });
    assert.equal((await f.service.state(uuidA)).connection, 'connected');
    assert.equal((await f.service.state(uuidA)).enabled, true);
    await f.service.webhook({ updateId: 'membership-blocked', telegramId: '10001', command: null, blocked: true });
    assert.equal((await f.service.state(uuidA)).connection, 'blocked');
    assert.equal((await f.service.state(uuidA)).enabled, false);
    await f.service.webhook({ updateId: 'membership-unblocked', telegramId: '10001', command: null, blocked: false });
    assert.equal((await f.service.state(uuidA)).connection, 'error');
    assert.equal((await f.service.state(uuidA)).enabled, false);
    assert.equal((await f.service.state(uuidA)).lastError, 'reconnect_required');
    f.advance(); await f.service.deliverOne(); assert.equal(f.sent.length, 1, 'Unblocking does not send another activation or automatically resume');
  });

  await scenario('an activation paused during the HTTP send keeps its acknowledgement but cannot reactivate', async f => {
    await f.service.authorize({ userId: uuidA, telegramId: '10001', language: 'en' }); f.advance();
    let sending!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { sending = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setOnSend(async () => { sending(); await gate; });
    const dispatched = f.service.deliverOne(); await started;
    await f.makeService().update(uuidA, { enabled: false });
    release(); await dispatched; f.setOnSend(null);
    assert.equal((await f.service.state(uuidA)).enabled, false);
    assert.notEqual((await f.service.state(uuidA)).connection, 'connected');
    assert.equal(await f.count('telegram_notification_outbox', "kind='activation' AND status='sent' AND message_id IS NOT NULL"), 1);
    f.advance(); await f.service.deliverOne(); assert.equal(f.sent.length, 1);
  });

  await scenario('pausing an in-flight trade preserves its sent acknowledgement and cancels later pending alerts', async f => {
    await f.favorite(); await f.activate(); await f.trade(); await f.service.collect();
    let sending!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { sending = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setOnSend(async () => { sending(); await gate; });
    const dispatched = f.service.deliverOne(); await started;
    f.advance(100); await f.trade(); await f.service.collect();
    await f.makeService().update(uuidA, { enabled: false });
    release(); await dispatched; f.setOnSend(null);
    assert.equal((await f.service.state(uuidA)).enabled, false);
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='sent' AND message_id IS NOT NULL"), 1);
    assert.equal(await f.count('telegram_notification_outbox', "kind='trades' AND status='pending'"), 0);
    f.advance(20_000); await f.makeService().deliverOne(); assert.equal(f.tradeMessages().length, 1);
  });

  await scenario('reauthorizing during an earlier activation cannot let the old generation enable the new connection', async f => {
    await f.service.authorize({ userId: uuidA, telegramId: '10001', language: 'en' }); f.advance();
    let sending!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { sending = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setOnSend(async () => { sending(); await gate; });
    const dispatched = f.service.deliverOne(); await started;
    await f.makeService().authorize({ userId: uuidA, telegramId: '10001', language: 'zh-CN' });
    release(); await dispatched; f.setOnSend(null);
    assert.equal((await f.service.state(uuidA)).connection, 'pending');
    assert.equal((await f.service.state(uuidA)).enabled, false);
    f.advance(); await f.makeService().deliverOne();
    assert.equal((await f.service.state(uuidA)).connection, 'connected');
    assert.equal((await f.service.state(uuidA)).language, 'zh-CN');
    assert.equal(await f.count('telegram_notification_outbox', "kind='activation' AND status='sent'"), 2);
  });

  await scenario('expired activation dispatch becomes a visible reconnect state rather than remaining pending', async f => {
    await f.service.authorize({ userId: uuidA, telegramId: '10001', language: 'en' });
    await pool.query(`UPDATE telegram_notification_outbox SET status='leased',lease_id=$1,lease_until=$2,dispatch_started_at=$3
      WHERE kind='activation'`, [randomUUID(), new Date(f.now() - 1), new Date(f.now() - 5000)]);
    await f.makeService().deliverOne();
    assert.equal(await f.count('telegram_notification_outbox', "kind='activation' AND status='uncertain'"), 1);
    assert.equal((await f.service.state(uuidA)).connection, 'error');
    assert.equal((await f.service.state(uuidA)).enabled, false);
    assert.equal(f.sent.length, 0);
  });

  await scenario('cross-worker global and per-chat pacing applies while unfollowed pending trades stay silent', async f => {
    await f.favorite(uuidA); await f.favorite(uuidB); await f.activate(uuidA); await f.activate(uuidB, '10002');
    await f.trade(); await f.service.collect();
    const first = await Promise.all([f.service.deliverOne(), f.makeService().deliverOne(), f.makeService().deliverOne()]);
    assert.equal(first.filter(Boolean).length, 1, 'Only one global slot is consumed at this instant');
    assert.equal(f.tradeMessages().length, 1);
    f.advance(39); await f.makeService().deliverOne(); assert.equal(f.tradeMessages().length, 1);
    f.advance(1); await f.makeService().deliverOne(); assert.equal(f.tradeMessages().length, 2);
    f.advance(100); await f.trade(); await f.service.collect();
    await pool.query('DELETE FROM account_watch_entries WHERE user_id=$1', [uuidA]);
    f.advance(10_000); await f.drain();
    assert.equal(f.tradeMessages().filter(message => message.chatId === '10001').length, 1);
    assert.equal(f.tradeMessages().filter(message => message.chatId === '10002').length, 2);
  });

  await scenario('leases survive worker restarts, unknown post-dispatch outcomes do not resend, and schema setup preserves data', async f => {
    await f.favorite(); await f.activate(); await f.trade(); await f.service.collect();
    const job = (await pool.query("SELECT id FROM telegram_notification_outbox WHERE kind='trades'")).rows[0].id;
    await pool.query(`UPDATE telegram_notification_outbox SET status='leased',lease_id=$2,lease_until=$3,dispatch_started_at=$4 WHERE id=$1`, [job, randomUUID(), new Date(f.now() - 1), new Date(f.now() - 5000)]);
    await f.makeService().deliverOne(); assert.equal(await f.count('telegram_notification_outbox', "status='uncertain'"), 1);
    assert.equal(f.tradeMessages().length, 0);
    await ensureSchema(); await Promise.all([ensureTelegramNotificationsSchema(pool), ensureTelegramNotificationsSchema(pool)]);
    assert.equal((await f.service.state(uuidA)).enabled, true); assert.equal(await f.count('telegram_notification_outbox', 'id=$1', [job]), 1);
    assert.equal(await f.count('telegram_notification_items'), 1);
  });

  console.log(`Telegram notification integration passed: ${testCount} disposable-database scenarios; fake Bot API only, no GMGN/RPC or real messages.`);
} finally { await pool.end(); }
