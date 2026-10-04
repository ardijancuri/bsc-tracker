import { describe, expect, it } from 'vitest';
import { hashSecret, sessionSecret } from './intelligenceApi.js';

describe('private watchlist sessions', () => {
  it('rejects malformed and ambiguous session cookies', () => {
    const secret = 'a'.repeat(64);
    expect(sessionSecret('other=1; bscan_watch=' + secret)).toBe(secret);
    expect(sessionSecret('bscan_watch=' + secret + '; bscan_watch=' + secret)).toBeNull();
    expect(sessionSecret('bscan_watch=guess')).toBeNull();
    expect(sessionSecret(undefined)).toBeNull();
    expect(hashSecret(secret)).not.toBe(secret);
  });
});
