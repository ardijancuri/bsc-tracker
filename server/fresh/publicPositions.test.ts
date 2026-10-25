import { describe, expect, it } from 'vitest';
import { freshPublicPosition } from './publicPositions.js';
const proof = () => ({ wallet_addresses: ['0x' + '1'.repeat(40)], token_address: '0x' + '2'.repeat(40), quantity_q: '10/1',
  balance_quantity: '10', balance_status: 'matched', balance_block: '100', balance_hash: '0x' + 'a'.repeat(64),
  balance_checked_at: '2026-10-20T10:01:00.000Z', last_event_at: '2026-10-20T10:00:00.000Z', last_event_block: '99', capture_block: '999',
  wallet_gap: false, decoding_pending: false, registration_pending: false });
describe('public current position proof', () => {
  it('keeps the original canonical observation while quiet collection advances', () => {
    expect(freshPublicPosition(proof())).toMatchObject({ confirmed: true, status: 'Holding', balance: '10', blockNumber: '100',
      checkedAt: '2026-10-20T10:01:00.000Z', coveredThroughBlock: '999' });
  });
  it('preserves a confirmed closed position without inventing a new observation time', () => {
    expect(freshPublicPosition({ ...proof(), quantity_q: '0', balance_quantity: '0' })).toMatchObject({ confirmed: true, status: 'Exited', balance: '0', checkedAt: proof().balance_checked_at });
  });
  it.each(['wallet_gap', 'decoding_pending', 'registration_pending'])('does not approve unresolved %s coverage', field => {
    expect(freshPublicPosition({ ...proof(), [field]: true })).toMatchObject({ confirmed: false, status: 'Unknown', balance: null });
  });
  it.each([{ balance_quantity: '9' }, { balance_status: 'mismatch' }, { balance_hash: null }, { balance_block: '98' },
    { capture_block: '99' }, { balance_checked_at: '2026-10-20T09:59:00.000Z' }])('rejects contradictory or incomplete proof %j', change => {
    expect(freshPublicPosition({ ...proof(), ...change })).toMatchObject({ confirmed: false, status: 'Unknown' });
  });
});
