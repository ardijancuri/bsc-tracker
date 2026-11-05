import { readFileSync } from 'node:fs';
import { Interface, id, toBeHex } from 'ethers';
import { describe, expect, it } from 'vitest';
import { WBNB } from '../launchpad.js';
import { poolMarketAbi } from '../nodeMarketProtocols.js';
import type { FreshReceipt, FreshTransaction } from './capture.js';
import { freshFlapPoolV2Settlement } from './flapPoolV2Settlement.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/flapPoolLaunchChain.json', import.meta.url), 'utf8')) as {
  wallet: string; token: string; pool: string;
  buy: { transaction: FreshTransaction; receipt: FreshReceipt };
  sell: { transaction: FreshTransaction; receipt: FreshReceipt };
};
const { wallet, token, pool } = fixture;
const identity = { poolAddress: pool, quoteAddress: WBNB };
const quantity = 1133234294416661076682n;
const settle = (side: 'buy' | 'sell', mutate?: (entry: typeof fixture.buy) => void) => {
  const entry = structuredClone(fixture[side]);
  mutate?.(entry);
  return freshFlapPoolV2Settlement(entry.transaction, wallet, token, side === 'buy' ? quantity : -quantity, entry.receipt.logs, identity);
};

describe('Flap Pool Launch standard V2 settlement', () => {
  it('binds real fee-on-transfer buy and sell receipts to their wrapped BNB wallet settlements', () => {
    expect(settle('buy')).toBe(22000000000000000n);
    expect(settle('sell')).toBe(23173331575150068n);
  });

  it('rejects a fake pool, signed payer mismatch, trailing calldata or native value', () => {
    const { transaction, receipt } = fixture.sell;
    expect(freshFlapPoolV2Settlement(transaction, wallet, token, -quantity, receipt.logs, { ...identity, poolAddress: token })).toBeNull();
    expect(settle('sell', entry => { entry.transaction.from = token; })).toBeNull();
    expect(settle('sell', entry => { entry.transaction.input += '00'; })).toBeNull();
    expect(settle('sell', entry => { entry.transaction.value = '0x1'; })).toBeNull();
    expect(settle('sell', entry => { entry.transaction.authorizationList = []; })).toBeNull();
  });

  it('requires exact quote transfer and canonical swap sender and recipient', () => {
    expect(settle('sell', entry => {
      entry.receipt.logs.find(log => log.address === WBNB)!.data = toBeHex(1, 32);
    })).toBeNull();
    expect(settle('buy', entry => {
      const swap = entry.receipt.logs.at(-1)!, event = poolMarketAbi.decodeEventLog('Swap', swap.data, swap.topics);
      Object.assign(swap, poolMarketAbi.encodeEventLog('Swap', [event.sender, event.amount0In, event.amount1In, event.amount0Out, event.amount1Out, token]));
    })).toBeNull();
  });

  it('does not mistake a WBNB withdrawal for wallet proceeds', () => {
    expect(settle('sell', entry => {
      const log = entry.receipt.logs.find(log => log.address === WBNB)!;
      const abi = new Interface(['event Withdrawal(address indexed src,uint256 wad)']);
      Object.assign(log, abi.encodeEventLog('Withdrawal', [wallet, BigInt(log.data)]));
      expect(log.topics[0]).toBe(id('Withdrawal(address,uint256)'));
    })).toBeNull();
  });
});
