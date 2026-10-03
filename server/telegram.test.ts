import { describe, expect, it } from 'vitest';
import { deliveryOutcome, hashSecret, validWebhookSecret } from './telegram.js';
import { sessionSecret } from './intelligenceApi.js';
describe('private session and webhook tokens', () => {
  it('rejects malformed and ambiguous session cookies', () => {
    const secret = 'a'.repeat(64);
    expect(sessionSecret(`other=1; bscan_watch=${secret}`)).toBe(secret);
    expect(sessionSecret(`bscan_watch=${secret}; bscan_watch=${secret}`)).toBeNull();
    expect(sessionSecret('bscan_watch=guess')).toBeNull();
    expect(sessionSecret(undefined)).toBeNull();
    expect(hashSecret(secret)).not.toBe(secret);
  });
  it('authenticates webhook secrets without allowing prefixes or array values', () => {
    expect(validWebhookSecret('secret', 'secret')).toBe(true);
    expect(validWebhookSecret('secret!', 'secret')).toBe(false);
    expect(validWebhookSecret(['secret'], 'secret')).toBe(false);
    expect(validWebhookSecret(undefined, 'secret')).toBe(false);
  });
});
describe('notification delivery', () => {
  it('stores successful sends and permanent failures', () => {
    expect(deliveryOutcome({ ok: true, result: { message_id: 42 } }, 1).status).toBe('sent');
    expect(deliveryOutcome({ ok: false, error_code: 403 }, 1).status).toBe('failed');
  });
  it('obeys Telegram retry_after, with bounded retries on explicit server failures', () => {
    expect(deliveryOutcome({ ok: false, error_code: 429, parameters: { retry_after: 89 } }, 2)).toEqual({ status: 'queued', retrySeconds: 89 });
    expect(deliveryOutcome({ ok: false, error_code: 503 }, 2)).toEqual({ status: 'queued', retrySeconds: 20 });
    expect(deliveryOutcome({ ok: false, error_code: 503 }, 5).status).toBe('failed');
  });
  it('does not replay a send when a timeout or restart leaves the result uncertain', () => {
    expect(deliveryOutcome({ ok: false, uncertain: true }, 1).status).toBe('uncertain');
  });
});
