import type { Position } from '../../shared/intelligence.js';
import { freshDecimal, FreshRational } from './accounting.js';

/** An unchanged position keeps its original confirmed balance observation.
 * Collection/decoder coverage proves no relevant movement was skipped since. */
export function freshPublicPosition(row: Record<string, any>): Position {
  const date = (value: unknown) => value == null ? null : new Date(value as string).toISOString();
  let confirmed = false;
  try {
    confirmed = row.balance_status === 'matched' && row.balance_quantity != null && row.balance_block != null
      && /^0x[\da-f]{64}$/i.test(row.balance_hash ?? '') && row.capture_block != null && row.last_event_block != null
      && BigInt(row.balance_block) >= BigInt(row.last_event_block) && BigInt(row.balance_block) <= BigInt(row.capture_block)
      && Date.parse(row.balance_checked_at) >= Date.parse(row.last_event_at)
      && FreshRational.parse(row.balance_quantity).compare(FreshRational.parse(row.quantity_q)) === 0
      && !row.wallet_gap && !row.decoding_pending && !row.registration_pending;
  } catch { confirmed = false; }
  return { walletAddress: row.wallet_addresses[0], tokenAddress: row.token_address,
    balance: confirmed ? freshDecimal(row.balance_quantity) : null,
    status: confirmed ? FreshRational.parse(row.quantity_q).n > 0n ? 'Holding' : 'Exited' : 'Unknown',
    checkedAt: date(row.balance_checked_at), blockNumber: row.balance_block == null ? null : String(row.balance_block),
    lastMovementAt: date(row.last_event_at), confirmed,
    coveredThroughBlock: row.capture_block == null ? null : String(row.capture_block) };
}
