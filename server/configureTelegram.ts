const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const origin = new URL(process.env.PUBLIC_APP_URL || 'https://bscan.fun');
if (!token || !secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret) || origin.protocol !== 'https:') throw new Error('Configure the private bot token, webhook secret and HTTPS PUBLIC_APP_URL first');
async function request(method: string, body: unknown) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const result = await response.json() as { ok: boolean; error_code?: number; result?: { username: string } };
    if (!result.ok) throw new Error(`Telegram configuration failed (${result.error_code || response.status})`);
    return result.result;
  } catch (error) { throw new Error(error instanceof Error && error.message.startsWith('Telegram configuration failed') ? error.message : 'Telegram configuration request failed'); }
}
const bot = await request('getMe', {});
await request('setWebhook', { url: `${origin.origin}/api/telegram/webhook`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
await request('setMyCommands', { commands: [{ command: 'start', description: 'Connect from bscan' }, { command: 'stop', description: 'Stop alerts' }] });
console.log(`Webhook registered for @${bot?.username}. Delivery ${process.env.TELEGRAM_DELIVERY_ENABLED === 'true' ? 'enabled' : 'disabled'}.`);
export {};
