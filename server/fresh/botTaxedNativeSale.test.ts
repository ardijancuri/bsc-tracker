import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { WBNB } from '../launchpad.js';
import { RpcRequestError } from '../rpc.js';
import { FreshRational } from './accounting.js';
import { freshBotTaxedNativeSale, isFreshBotTaxedNativeSale } from './botTaxedNativeSale.js';
import type { FreshCapturedReceipt } from './capture.js';
import { normalizeFreshReceipt } from './decode.js';
import { freshQuoteUsd, freshTokenMetadata, type FreshPriceBlock } from './pricing.js';
import { createFreshStateEvidenceRpc } from './stateEvidence.js';
import type { FreshCallTrace } from './trace.js';

type SaleFixture = { entry: FreshCapturedReceipt; block: FreshPriceBlock; token: string; sold: string; gross: string; net: string; eventId: string };
// Original confirmed V2-only and V2/V3 sales. Each route includes a retained
// trace, receipt-only proof and a separate token-owned tax swap.
const fixtures = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/bot-taxed-native-sales.json.gz', import.meta.url))).toString()) as SaleFixture[];
const prove = (fixture: SaleFixture) => freshBotTaxedNativeSale(fixture.entry, fixture.block, fixture.token, fixture.entry.transaction.from, -BigInt(fixture.sold));
const calls = (node: FreshCallTrace): FreshCallTrace[] => [node, ...(node.calls ?? []).flatMap(calls)];

async function normalize(fixture: SaleFixture) {
  const { entry, block, token } = fixture;
  const misses: string[] = [];
  const state = createFreshStateEvidenceRpc(async method => {
    misses.push(method);
    throw new RpcRequestError('offline_no_rpc', 'state_unavailable');
  }, block, entry.stateEvidence);
  const price = await freshQuoteUsd(WBNB, { rpc: state.rpc, block });
  const result = await normalizeFreshReceipt(entry, {
    number: entry.transaction.blockNumber, hash: block.hash, timestamp: '0x' + (Date.parse(block.timestamp) / 1_000).toString(16),
  }, {
    metadata: address => freshTokenMetadata(address, { rpc: state.rpc, block, requireSupply: false }),
    knownLaunch: async address => address === token,
    eligible: async metadata => metadata.address === token,
    priceUsd: async address => address === WBNB ? price : null,
  });
  expect(state.rejectedPrior).toBe(false);
  expect(state.writes).toBe(0);
  expect(misses).toEqual([]);
  return { result, price };
}

describe('taxed bot native sale', () => {
  it.each(fixtures.map((_, i) => i))('recovers verified proceeds and independent chain gas for real receipt %s', async index => {
    const fixture = structuredClone(fixtures[index]);
    expect(isFreshBotTaxedNativeSale(fixture.entry.transaction)).toBe(true);
    expect(prove(fixture)).toEqual({ grossWithdrawnWei: fixture.gross, walletReceivedWei: fixture.net,
      routeExpenseWei: String(BigInt(fixture.gross) - BigInt(fixture.net)) });
    const { result, price } = await normalize(fixture);
    const { transaction: tx, receipt } = fixture.entry;
    const native = new FreshRational(BigInt(fixture.net), 10n ** 18n);
    const gas = new FreshRational(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? tx.gasPrice!), 10n ** 18n);
    expect(result.reasons).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: fixture.eventId, kind: 'sell', quoteAddress: WBNB, quoteSymbol: 'BNB',
      quoteAmount: native.decimal(), amountUsd: native.mul(FreshRational.parse(price)).decimal(), feeUsd: gas.mul(FreshRational.parse(price)).decimal() });
  });

  it.each([1, 4])('never uses gross withdrawal when the claimed route has a contradictory receipt %i', async index => {
    const fixture = structuredClone(fixtures[index]);
    const settlement = fixture.entry.receipt.logs.at(-1)!;
    settlement.data = settlement.data.slice(0, 66) + BigInt(fixture.gross).toString(16).padStart(64, '0');
    expect(isFreshBotTaxedNativeSale(fixture.entry.transaction)).toBe(true);
    expect(prove(fixture)).toBeNull();
    const { result } = await normalize(fixture);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: fixture.eventId, kind: 'sell', amountUsd: null });
    expect(result.events[0].quoteAmount).toBeUndefined();
    expect(result.reasons).toContain('trade_value_unavailable');
  });

  it.each([0, 3])('rejects contradictory trace even when the original signed call and receipt match %i', index => {
    const fixture = structuredClone(fixtures[index]);
    const payout = calls(fixture.entry.trace!).find(call => call.to === fixture.entry.transaction.from && call.value && BigInt(call.value) > 0n)!;
    payout.value = '0x1';
    expect(prove(fixture)).toBeNull();
  });

  it('requires the direct V2 WBNB payment to fund the full withdrawal', async () => {
    const fixture = structuredClone(fixtures[4]);
    const transfer = fixture.entry.receipt.logs.find(log => log.address === WBNB && log.topics[0].startsWith('0xddf252ad') && BigInt(log.data) === BigInt(fixture.gross))!;
    transfer.data = '0x' + (BigInt(fixture.gross) - 1n).toString(16).padStart(64, '0');
    expect(prove(fixture)).toBeNull();
    const { result } = await normalize(fixture);
    expect(result.events[0].amountUsd).toBeNull();
    expect(result.events[0].quoteAmount).toBeUndefined();
    expect(result.reasons).toContain('native_payout_mismatch');
  });

  it('requires the exact bound token quantity and canonical receipt position', () => {
    const fixture = structuredClone(fixtures[1]);
    expect(freshBotTaxedNativeSale(fixture.entry, fixture.block, fixture.token, fixture.entry.transaction.from, 1n - BigInt(fixture.sold))).toBeNull();
    fixture.entry.receipt.logs[0].blockHash = '0x' + 'f'.repeat(64);
    expect(prove(fixture)).toBeNull();
  });
});
