import { describe, expect, it } from 'vitest';
import type { InventoryEvent, KolTokenActivity, KolTokenTrade } from '../shared/kolTokenTrades.js';
import { buildTradeReplayGmgnAccounting, type GmgnReplayActivity } from './tradeReplayGmgnAccounting.js';

const now = Date.parse('2026-10-14T02:12:11.921Z');
const checkedAt = new Date(now).toISOString();
const wallet = '0xa05ec35f7d1eba823cff2ed26aeaed419683742f';
const token = '0x71b58f07e2962de4691f3da80d54cfc8cfcc7777';
const native = '0x' + '0'.repeat(40);
const hash = (id: number) => '0x' + id.toString(16).padStart(64, '0');
function provider(id: number, kind: InventoryEvent['kind'], quantity: string, usd: string, extra: Partial<GmgnReplayActivity> = {}): GmgnReplayActivity {
  return { wallet, chain: 'bsc', tx_hash: hash(id), timestamp: 1791907047 + id, event_type: kind, token: { address: token },
    token_amount: quantity, cost_usd: usd, quote_amount: usd, quote_address: native, quote_token: { token_address: native, symbol: 'BNB' },
    gas_usd: '0', dex_usd: '0', priority_fee: '0', tip_fee: '0', ...extra };
}
function canonical(rows: GmgnReplayActivity[], cash: (string | null)[] = rows.map(row => String(row.quote_amount))): KolTokenActivity {
  let quantity = 0;
  const events: InventoryEvent[] = rows.map((row, index) => {
    const kind = row.event_type as InventoryEvent['kind'];
    quantity += Number(row.token_amount) * (kind === 'buy' || kind === 'transfer_in' ? 1 : -1);
    return { id: `event-${index}`, ...(kind === 'buy' || kind === 'sell' ? { tradeId: `trade-${index}` } : {}),
      txHash: String(row.tx_hash), kind, timestamp: new Date(Number(row.timestamp) * 1000).toISOString(), blockNumber: String(100 + index),
      transactionIndex: index, logIndex: kind.startsWith('transfer') ? index : null, tokenAmount: String(row.token_amount),
      remainingTokenAmount: String(quantity), remainingCostBasisUsd: '0', cumulativeRealizedProfitUsd: '0', investedUsd: '0', soldUsd: '0' };
  });
  const trades: KolTokenTrade[] = events.flatMap((event, index) => event.tradeId ? [{ id: event.tradeId, txHash: event.txHash, walletAddress: wallet,
    tokenAddress: token, kolName: null, kolAvatarUrl: null, kolTwitter: null, tokenSymbol: null, tokenName: null, tokenLogoUrl: null,
    side: event.kind as 'buy' | 'sell', tokenAmount: event.tokenAmount, quoteSymbol: 'BNB', quoteTokenAddress: null, quoteAmount: cash[index],
    amountUsd: String(rows[index].cost_usd), priceUsd: null, marketCapUsd: null, timestamp: event.timestamp, source: 'node',
    blockNumber: event.blockNumber, transactionIndex: index, valuationStatus: 'valued', realizedProfitUsd: null, cumulativeRealizedProfitUsd: '0' }] : []);
  return { kol: { address: wallet, name: null, avatarUrl: null, twitter: null, source: 'indexed', lastSeenAt: null },
    token: { address: token, symbol: null, name: null, logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: null }, trades,
    summary: { investedUsd: '0', soldUsd: '0', realizedProfitUsd: '0', avgBoughtPriceUsd: null, avgSoldPriceUsd: null,
      avgBoughtMcapUsd: null, avgSoldMcapUsd: null, remainingTokenAmount: String(quantity), remainingCostBasisUsd: '0', buyCount: 0, sellCount: 0,
      valuedBuyCount: 0, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0, firstTradeAt: null, lastTradeAt: null, status: 'open', profitBasis: 'observed_fifo' },
    inventory: { version: 1, events, coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: '200000000',
      blockHash: hash(999), checkedAt, balance: String(quantity), status: 'verified', initialBalanceSource: 'derived_complete_movements' } },
    coverage: { source: 'indexed', indexedTradeCount: trades.length, returnedTradeCount: trades.length, complete: true, historyLimit: 10000, costsIncluded: false }, generatedAt: checkedAt };
}
const build = (activity: KolTokenActivity, rows: GmgnReplayActivity[], aggregateRow?: Record<string, unknown>) =>
  buildTradeReplayGmgnAccounting(activity, rows, { activitiesComplete: true, aggregateRow, now, checkedAt });

// Public official-CLI observations. Receipt-backed native cash differs from
// displayed GMGN quote amounts because launchpad fees and taxes are implicit.
const yukazRows = [
  provider(1, 'buy', '89957115.52122651', '504.7640136', { timestamp: 1791907047, quote_amount: '0.67914', gas_usd: '1.585163691', dex_usd: '10.3013064' }),
  provider(2, 'sell', '42516099.04942224', '567.3272474211151', { timestamp: 1791907066, quote_amount: '0.763203400041858', buy_cost_usd: '246.64153211432816', gas_usd: '0.03772602345599999', dex_usd: '11.346544948422302' }),
  provider(3, 'transfer_out', '22663914.21156394', '414.2129032552619', { timestamp: 1791907093, quote_amount: '', quote_address: '', gas_usd: '0.0110331808884' }),
  provider(4, 'buy', '845506.1678751096', '7.21916118', { timestamp: 1791907201, quote_amount: '0.009702', gas_usd: '0.0352307566296', dex_usd: '0.14732982' }),
  provider(5, 'buy', '100864.27872418055', '3.617075385', { timestamp: 1791908169, quote_amount: '0.004851', gas_usd: '0.0353049821388', dex_usd: '0.073817865' }),
];
function yukaz() {
  const activity = canonical(yukazRows, ['0.7', '0.7404599387206107', null, '0.01', '0.005']);
  const blocks = ['127430619', '127430663', '127430722', '127430963', '127433114'];
  activity.inventory!.events.forEach((event, index) => { event.blockNumber = blocks[index]; });
  activity.inventory!.coverage.balance = '25723472.70683961';
  activity.inventory!.events.at(-1)!.remainingTokenAmount = '25723472.70683961';
  return activity;
}
const yukazAggregate: Record<string, unknown> = { address: wallet, balance: 25723472.70683961, usd_value: 2695.271000769227,
  cost_cur: 154.97509579412701, history_bought_cost: 515.60046846, history_bought_fee: 17.492533100468,
  history_sold_income: 567.3272474211151, history_sold_fee: 16.94407799660523, history_transfer_in_cost: 0,
  history_transfer_out_income: 414.2129032552619, history_transfer_out_fee: 0.0110331808884,
  current_buy_amount: 90903485.9678258, current_sell_amount: 42516099.04942224, history_transfer_in_amount: 0,
  history_transfer_out_amount: 22663914.21156394, buy_tx_count_cur: 3, sell_tx_count_cur: 1, transfer_in_count: 0, transfer_out_count: 1,
  last_block: 127433114, last_active_timestamp: 1791908169, total_cost: 550.0481127379616, profit: 3126.7630387076424,
  profit_change: 5.684526437412225, realized_profit: 586.4671337325424, unrealized_profit: 2540.2959049751003 };

describe('GMGN replay fee and marked-transfer accounting', () => {
  it('derives full transaction friction from matched native flows rather than only displayed gas and DEX fees', () => {
    const activity = yukaz(), before = structuredClone(activity);
    const result = build(activity, yukazRows);
    expect(result.coverage).toMatchObject({ transactionsComplete: true, balanceMatched: true, exactFinal: false });
    expect(Number(result.events[0].feesUsd)).toBeCloseTo(17.089150091, 9);
    expect(Number(result.events[0].remainingCostBasisUsd)).toBeCloseTo(521.853163691, 9);
    expect(Number(result.events[1].cumulativeRealizedProfitUsd)).toBeCloseTo(303.7416373101818, 8);
    expect(Number(result.events[2].cumulativeRealizedProfitUsd)).toBeCloseTo(586.4671337325424, 8);
    expect(Number(result.events[2].transferOutIncomeUsd)).toBeCloseTo(414.2129032552619, 8);
    expect(activity).toEqual(before);
  });

  it('keeps aggregate FX rounding entirely in a separately reconciled final snapshot', () => {
    const prefix = build(yukaz(), yukazRows), result = build(yukaz(), yukazRows, yukazAggregate);
    expect(result.status).toBe('ready');
    expect(result.events).toEqual(prefix.events);
    expect(result.final).toMatchObject({ reportedProfitUsd: '3126.76303870764', reportedRoi: '5.68452643741222' });
    expect(Number(result.final!.feeInclusiveCostUsd)).toBeCloseTo(550.0481127379616, 9);
    expect(Number(result.events.at(-1)!.feeInclusiveCostUsd)).toBeCloseTo(550.047885607262, 9);
    expect(Number(result.final!.priceUsd)).toBeCloseTo(2695.271000769227 / 25723472.70683961, 12);
  });

  it.each(['balance', 'count', 'quantity', 'gross', 'block-future', 'block-old', 'time', 'identity', 'roi', 'wallet'] as const)(
    'rejects an aggregate with mismatched %s without modifying the prefix', variant => {
      const row = { ...yukazAggregate };
      if (variant === 'balance') row.balance = Number(row.balance) + 1;
      if (variant === 'count') row.buy_tx_count_cur = 4;
      if (variant === 'quantity') row.current_buy_amount = Number(row.current_buy_amount) + 1;
      if (variant === 'gross') row.history_bought_cost = Number(row.history_bought_cost) + 1;
      if (variant === 'block-future') row.last_block = 200000001;
      if (variant === 'block-old') row.last_block = 127433113;
      if (variant === 'time') row.last_active_timestamp = 1791908167;
      if (variant === 'identity') row.total_cost = Number(row.total_cost) + 1;
      if (variant === 'roi') row.profit_change = 1;
      if (variant === 'wallet') row.address = token;
      const result = build(yukaz(), yukazRows, row);
      expect(result.final).toBeNull();
      expect(result.coverage.exactFinal).toBe(false);
      expect(result.events).toEqual(build(yukaz(), yukazRows).events);
    });

  it.each(['buy', 'sell'] as const)('does not substitute a matching current-cycle %s quantity for contradictory history', side => {
    const field = `${side}_amount_cur`;
    for (const invalid of [0, null, '', 'invalid', Number(yukazAggregate[`current_${side}_amount`]) + 1]) {
      const result = build(yukaz(), yukazRows, { ...yukazAggregate, [field]: invalid });
      expect(result.final).toBeNull();
      expect(result.coverage.exactFinal).toBe(false);
      expect(result.events).toEqual(build(yukaz(), yukazRows).events);
    }
  });

  it.each(['incomplete', 'missing', 'duplicate', 'wrong-token', 'wrong-quantity'] as const)('withholds money from %s provider history', variant => {
    const rows = structuredClone(yukazRows);
    if (variant === 'missing') rows.splice(2, 1);
    if (variant === 'duplicate') rows.push(rows[0]);
    if (variant === 'wrong-token') rows[0].token = { address: wallet };
    if (variant === 'wrong-quantity') rows[0].token_amount = '1';
    const result = buildTradeReplayGmgnAccounting(yukaz(), rows, { activitiesComplete: variant !== 'incomplete', aggregateRow: yukazAggregate, now, checkedAt });
    expect(result.coverage.transactionsComplete).toBe(false);
    expect(result.final).toBeNull();
    expect(result.events.every(event => event.remainingCostBasisUsd === null && event.feeInclusiveCostUsd === null)).toBe(true);
  });

  it.each(['different-quote', 'missing-quote', 'missing-gas', 'nonzero-tip', 'negative-implied-fee'] as const)('does not guess friction when %s', variant => {
    const row = provider(1, 'buy', '10', '100');
    const activity = canonical([row], [variant === 'negative-implied-fee' ? '50' : '100']);
    if (variant === 'different-quote') row.quote_address = token;
    if (variant === 'missing-quote') delete activity.trades[0].quoteTokenAddress;
    if (variant === 'missing-gas') delete row.gas_usd;
    if (variant === 'nonzero-tip') row.tip_fee = '0.1';
    const result = build(activity, [row]);
    expect(result.events[0].feeInclusiveCostUsd).toBeNull();
    expect(result.events[0].remainingCostBasisUsd).toBeNull();
  });

  it('accepts an exact ERC20 quote match and withholds a currency-mismatched quote', () => {
    const row = provider(1, 'buy', '10', '100', { quote_address: token });
    const activity = canonical([row], ['105']); activity.trades[0].quoteTokenAddress = token;
    expect(build(activity, [row]).events[0].feesUsd).toBe('5');
    activity.trades[0].quoteTokenAddress = wallet;
    expect(build(activity, [row]).events[0].feesUsd).toBeNull();
  });

  it('retains unknown opening basis even for one raw unit beside a large position', () => {
    const row = provider(1, 'buy', '100000000', '100'); const activity = canonical([row]);
    activity.inventory!.events[0].remainingTokenAmount = '100000000.000000000000000001';
    activity.inventory!.coverage.balance = '100000000.000000000000000001';
    expect(build(activity, [row]).events[0].remainingCostBasisUsd).toBeNull();
    expect(build(activity, [row]).events[0].feeInclusiveCostUsd).toBeNull();
  });

  it('assigns explicitly reported incoming marked basis, with no invented incoming fee', () => {
    const rows = [provider(1, 'transfer_in', '10', '100'), provider(2, 'transfer_out', '10', '200')];
    const result = build(canonical(rows), rows);
    expect(result.events[0]).toMatchObject({ remainingCostBasisUsd: '100', feeInclusiveCostUsd: '100', investedUsd: '0' });
    expect(result.events[1]).toMatchObject({ remainingCostBasisUsd: '0', cumulativeRealizedProfitUsd: '100', transferOutIncomeUsd: '200' });
    rows[0].gas_usd = '1';
    expect(build(canonical(rows), rows).events[0].feeInclusiveCostUsd).toBeNull();
  });

  it.each(['1', undefined])('lets a complete aggregate rescue incoming fee attribution (%s) without guessing prefix fees', incomingGas => {
    const rows = [provider(1, 'transfer_in', '10', '100', { gas_usd: incomingGas }), provider(2, 'transfer_out', '10', '200')];
    const activity = canonical(rows);
    const aggregate = { address: wallet, balance: 0, usd_value: 0, cost_cur: 0,
      history_bought_cost: 0, history_bought_fee: 0, history_sold_income: 0, history_sold_fee: 0,
      history_transfer_in_cost: 100, history_transfer_out_income: 200, history_transfer_out_fee: 0,
      current_buy_amount: 0, current_sell_amount: 0, history_transfer_in_amount: 10, history_transfer_out_amount: 10,
      buy_tx_count_cur: 0, sell_tx_count_cur: 0, transfer_in_count: 1, transfer_out_count: 1,
      last_block: 101, last_active_timestamp: Number(rows[1].timestamp),
      total_cost: 100, profit: 100, profit_change: 1, realized_profit: 100, unrealized_profit: 0 };
    const result = build(activity, rows, aggregate);
    expect(result.status).toBe('ready');
    expect(result.coverage.exactFinal).toBe(true);
    expect(result.final).toMatchObject({ reportedProfitUsd: '100', reportedRoi: '1', feeInclusiveCostUsd: '100' });
    expect(result.events.every(event => event.feeInclusiveCostUsd === null)).toBe(true);
  });

  it('consumes very small transfer quantities without clearing their cost silently', () => {
    const rows = [provider(1, 'buy', '0.0000000000001', '100'), provider(2, 'transfer_out', '0.0000000000001', '200')];
    const activity = canonical(rows);
    // Canonical quantities always use decimal token units, not exponent notation.
    activity.inventory!.events[0].remainingTokenAmount = '0.0000000000001';
    const result = build(activity, rows);
    expect(result.events[1].cumulativeRealizedProfitUsd).toBe('100');
    expect(result.events[1].remainingCostBasisUsd).toBe('0');
  });

  it('rejects different tiny provider quantities even below the usual absolute rounding threshold', () => {
    const rows = [provider(1, 'buy', '0.0000000000001', '100')];
    const activity = canonical(rows); activity.inventory!.events[0].remainingTokenAmount = '0.0000000000001';
    rows[0].token_amount = '0.0000000000002';
    expect(build(activity, rows).coverage.transactionsComplete).toBe(false);
    expect(build(activity, rows).events[0].remainingCostBasisUsd).toBeNull();
  });

  it('closes known prefixes using cash flows when provider disposal basis was rounded', () => {
    const rows = [provider(1, 'buy', '10', '100'), provider(2, 'sell', '10', '200', { buy_cost_usd: '99.99999999' })];
    const result = build(canonical(rows), rows);
    expect(result.events[1]).toMatchObject({ remainingCostBasisUsd: '0', cumulativeRealizedProfitUsd: '100', feeInclusiveCostUsd: '100' });
  });

  it.each(['provider-stale', 'provider-future', 'inventory-stale', 'inventory-pending', 'malformed-block'] as const)(
    'rejects %s proof before producing monetary snapshots', variant => {
      const activity = yukaz(); let at = checkedAt;
      if (variant === 'provider-stale') at = new Date(now - 180001).toISOString();
      if (variant === 'provider-future') at = new Date(now + 1).toISOString();
      if (variant === 'inventory-stale') activity.inventory!.coverage.checkedAt = new Date(now - 180001).toISOString();
      if (variant === 'inventory-pending') { activity.inventory!.coverage.complete = false; activity.inventory!.coverage.status = 'pending'; }
      if (variant === 'malformed-block') activity.inventory!.events[0].blockNumber = 'bad';
      const result = buildTradeReplayGmgnAccounting(activity, yukazRows, { activitiesComplete: true, now, checkedAt: at });
      expect(result.events).toEqual([]);
      expect(result.status).toBe(variant === 'inventory-pending' ? 'pending' : 'unavailable');
    });
});

describe('closed Afeng/Taku official provider snapshot', () => {
  it('verifies full fee-inclusive loss while keeping unproven quote currency out of animated estimates', () => {
    const afeng = '0xbf004bff64725914ee36d03b87d6965b0ced4903', taku = '0x58cc3796eceb9e3e627b2bc92eb52bea37557777';
    const quote = '0x205812cdbed920aff76c6580abd681a46d11efc7';
    const rows = [
      provider(1, 'buy', '29456803.80328239', '545.6194764136875', { wallet: afeng, token: { address: taku }, timestamp: 1791922345,
        quote_address: quote, quote_amount: '0.732323442864824', gas_usd: '0.049066934139', dex_usd: '5.7870110863125' }),
      provider(2, 'sell', '29456803.80328239', '490.26595894995165', { wallet: afeng, token: { address: taku }, timestamp: 1791922384,
        quote_address: quote, quote_amount: '0.657925604166308', gas_usd: '0.0585676521864', dex_usd: '10.045549498884508', buy_cost_usd: '557.025316934139' }),
    ];
    const activity = canonical(rows); activity.kol.address = afeng; activity.token.address = taku;
    activity.inventory!.events[0].blockNumber = '127464607'; activity.inventory!.events[1].blockNumber = '127464694';
    const row = { address: afeng, balance: 0, usd_value: 0, cost_cur: 0, history_bought_cost: 545.6194764136875,
      history_bought_fee: 11.4058405204515, history_sold_income: 490.26595894995165, history_sold_fee: 14.90632124558158,
      history_transfer_in_cost: 0, history_transfer_out_income: 0, history_transfer_out_fee: 0,
      current_buy_amount: 29456803.80328239, current_sell_amount: 29456803.80328239, history_transfer_in_amount: 0, history_transfer_out_amount: 0,
      buy_tx_count_cur: 1, sell_tx_count_cur: 1, transfer_in_count: 0, transfer_out_count: 0, last_block: 127464694, last_active_timestamp: 1791922384,
      total_cost: 571.9316381797206, profit: -81.66567922976894, profit_change: -0.14278923175099253, realized_profit: -81.66567922976894, unrealized_profit: 0 };
    const result = build(activity, rows, row);
    expect(result.status).toBe('ready');
    expect(result.final).toMatchObject({ priceUsd: null, remainingTokenAmount: '0', reportedProfitUsd: '-81.6656792297689', reportedRoi: '-0.142789231750993' });
    expect(result.events.every(event => event.feeInclusiveCostUsd === null)).toBe(true);
  });
});

describe('David/元宝 official provider snapshot with a fully exited earlier cycle', () => {
  it('reconciles all-history quantities and final profit without mixing BABAB quotes with native BNB', () => {
    const david = '0x7a2363a401b2340c7941dd2eeff0196a5078d2e6', yuanbao = '0xba5dd6b869512f7f3acaf565e5c6dde076727777';
    const babab = '0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec';
    const observations: [InventoryEvent['kind'], string, string, number][] = [
      ['buy', '32970749.454012856', '465.9176764905549', 1791950621],
      ['sell', '10550639.825284114', '301.89898164183296', 1791950629],
      ['buy', '253124.1513768271', '7.22463760686168', 1791950640],
      ['buy', '336673.626310296', '7.222893486537339', 1791950651],
      ['sell', '23009907.406415865', '183.3661678411393', 1791950660],
      ['buy', '26989181.397799186', '375.55795202797793', 1791950678],
      ['buy', '17159480.330396883', '216.5741554076847', 1791950757],
      ['transfer_out', '21388689.49452374', '305.3353849791694', 1791950762],
      ['transfer_in', '1043731.173058266', '31.677217551010806', 1791950856],
      ['buy', '22506038.943878736', '216.56648424403616', 1791950943],
      ['buy', '15234789.545340778', '216.7813379836211', 1791951032],
      ['transfer_out', '29557740.40972603', '388.1406308685412', 1791951091],
      ['transfer_out', '15396494.677308949', '276.8595545742637', 1791951198],
      ['buy', '15644682.781038782', '216.41045320683762', 1791951509],
      ['transfer_out', '15516224.404720709', '314.37423818027065', 1791951550],
      ['transfer_out', '15873814.756819075', '321.619376661726', 1791951550],
      ['transfer_in', '9784351.629209666', '188.54237008853914', 1791951560],
      ['transfer_out', '2872484.655259865', '81.079492980406', 1791951711],
      ['transfer_in', '3867047.0843171193', '129.18031654320043', 1791951723],
      ['sell', '3487156.3460043143', '141.67402638939555', 1791951751],
    ];
    const rows = observations.map(([kind, quantity, usd, timestamp], index) => provider(index + 1, kind, quantity, usd,
      { wallet: david, token: { address: yuanbao }, timestamp, quote_address: babab, quote_token: { token_address: babab, symbol: 'BABAB' } }));
    rows[0].quote_amount = '4.114332738760088'; rows[0].gas_usd = '2.699849969788277'; rows[0].dex_usd = '14.342024573066713';
    const activity = canonical(rows); activity.kol.address = david; activity.token.address = yuanbao;
    activity.trades.forEach(trade => { trade.walletAddress = david; trade.tokenAddress = yuanbao; });
    activity.trades[0].quoteAmount = '0.65';
    const at = '2026-10-14T04:25:26.347Z'; activity.inventory!.coverage.checkedAt = at;
    activity.inventory!.events.at(-1)!.remainingTokenAmount = '8136698.140676733293235668';
    activity.inventory!.coverage.balance = '8136698.140676733293235668';
    const aggregate: Record<string, unknown> = { address: david, balance: 8136698.140676733, usd_value: 215.36050718450178,
      cost_cur: 192.6030713168681, history_bought_cost: 1722.2555904541116, history_bought_fee: 63.877191462362156,
      history_sold_income: 626.9391758723679, history_sold_fee: 22.53938175981237, history_transfer_in_cost: 349.3999041827504,
      history_transfer_out_income: 1687.4086782443771, history_transfer_out_fee: 0.0784312283388,
      history_transfer_in_amount: 14695129.886585051, history_transfer_out_amount: 100605448.39835837,
      current_buy_amount: 97534172.99845436, buy_amount_cur: 131094720.23015435,
      current_sell_amount: 3487156.3460043143, sell_amount_cur: 37047703.577704296,
      buy_tx_count_cur: 8, sell_tx_count_cur: 3, transfer_in_count: 3, transfer_out_count: 6,
      last_block: 119, last_active_timestamp: 1791951751, total_cost: 2158.1504990873755, profit: 371.55786221387143,
      profit_change: 0.1721649451097101, realized_profit: 348.80042634623777, unrealized_profit: 22.75743586763369 };
    const options = { activitiesComplete: true, now: Date.parse(at), checkedAt: at };
    const prefix = buildTradeReplayGmgnAccounting(activity, rows, options);
    const result = buildTradeReplayGmgnAccounting(activity, rows, { ...options, aggregateRow: aggregate });
    expect(result.status).toBe('ready');
    expect(result.coverage).toMatchObject({ transactionsComplete: true, balanceMatched: true, exactFinal: true });
    expect(result.final).toMatchObject({ reportedProfitUsd: '371.557862213871', reportedRoi: '0.17216494510971',
      cumulativeRealizedProfitUsd: '348.800426346238', feeInclusiveCostUsd: '2158.15049908738' });
    expect(result.events).toEqual(prefix.events);
    expect(result.events.every(event => event.feesUsd === null && event.feeInclusiveCostUsd === null)).toBe(true);
    expect(prefix.coverage.reason).toBe('quote_or_fee_unavailable');
    delete aggregate.buy_amount_cur; delete aggregate.sell_amount_cur;
    expect(buildTradeReplayGmgnAccounting(activity, rows, { ...options, aggregateRow: aggregate }).final).toBeNull();
  });
});
