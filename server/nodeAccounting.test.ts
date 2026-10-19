import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { NodeMarketQuote } from '../shared/nodeMarket.js';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import { calculateJournalLedger, type JournalLedgerBaseline, type JournalLedgerEvent } from './nodeAccountingLedger.js';
import { authenticNodeTokenCreation, createNodeAccountingService, nodeAccountingRangesComplete, nodeAccountingScopeKey, nodeQuoteCoversMovements, normalizeNodeExecutionFlows, saveNodeAccountingBaseline, type NodeExecutionFlow } from './nodeAccounting.js';
import { rollbackNodeAccounting } from './nodeAccountingSchema.js';
import { FOUR_MANAGERS, fourInterface, PCS_V2_FACTORY } from './launchpad.js';
import { poolMarketAbi, type NodeMarketIdentity } from './nodeMarketProtocols.js';
const wallet = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`, wbnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const blockHash = `0x${'f'.repeat(64)}`, stamp = '2026-10-19T00:00:00.000Z';
const event = (id: string, kind: 'buy' | 'sell', amount: string, quantity: string): JournalLedgerEvent => ({ id, walletAddress: wallet, tokenAddress: token,
  kind, tokenAmount: quantity, amountUsd: amount, feeUsd: '0', txHash: id, timestamp: stamp, blockNumber: id, transactionIndex: 1, logIndex: 1 });
const seed: JournalLedgerBaseline = { walletAddress: wallet, tokenAddress: token, investedUsd: '100', soldUsd: '150', incomingTransferCostUsd: '0', transferOutIncomeUsd: '0',
  realizedProfitUsd: '48', feesUsd: '2', feeInclusiveCapitalUsd: '101', lots: [] };
const calculate = (baseline: JournalLedgerBaseline, events: JournalLedgerEvent[], balance: string) => calculateJournalLedger({ wallets: [wallet], baselines: [baseline], events,
  coverage: [{ walletAddress: wallet, tokenAddress: token, complete: true }], valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: stamp, balances: [{ walletAddress: wallet, tokenAmount: balance }] }], asOf: stamp, timeline: true });
const quote: NodeMarketQuote = { tokenAddress: token, priceUsd: '2', marketCapUsd: '2000', supply: '1000', timestamp: stamp, blockNumber: '100', blockHash,
  source: 'node', marketId: 'market', stale: false, supplyEstimated: false, reason: null };
const flow = (overrides: Partial<NodeExecutionFlow> = {}): NodeExecutionFlow => ({ id: 'exec', tx_hash: blockHash, wallet_address: wallet, execution_index: 0, operation_hash: null,
  block_number: '100', block_hash: blockHash, transaction_index: 1, timestamp: stamp, status: 'success', kind: 'transaction', fee_native_wei: '1000000000000000',
  fee_complete: true, fee_reason: null, native_value_raw: '1000000000000000000', logs: [{ address: token, topics: ['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'], data: '0x' }],
  token_address: token, delta_raw: '10000000000000000000', decimals: 18, log_indices: [1], counterparties: [], eligible: true,
  trace:{type:'CALL',from:wallet,to:token,value:'0xde0b6b3a7640000'},...overrides });
afterEach(() => vi.restoreAllMocks());
describe('ending valuation boundary', () => {
  it('requires a mark at or after every included movement, including same-second block ordering', () => {
    const movement=event('101','buy','10','5');
    expect(nodeQuoteCoversMovements({...quote,blockNumber:'101'},[movement])).toBe(true);
    expect(nodeQuoteCoversMovements(quote,[movement])).toBe(false);
    expect(nodeQuoteCoversMovements({...quote,blockNumber:'102'},[{...movement,timestamp:new Date(Date.parse(stamp)+1000).toISOString()}])).toBe(false);
    expect(nodeQuoteCoversMovements({...quote,blockNumber:null,timestamp:new Date(Date.parse(stamp)+1000).toISOString()},[movement])).toBe(true);
  });
});
describe('shared exact accounting baseline handoff', () => {
  it('retains past realized profit and capital after a zero-balance closure and reopening', () => {
    const result = calculate(seed, [event('101', 'buy', '10', '10')], '10');
    expect(result.positions[0]).toMatchObject({ complete: true, realizedProfitUsd: '48', estimatedProfitUsd: '58', feeInclusiveCapitalUsd: '111', investedUsd: '110', soldUsd: '150' });
    expect(Number(result.positions[0].roi)).toBeCloseTo(58 / 111, 12);
  });
  it('preserves individual FIFO lots instead of replacing them with an average cost', () => {
    const result = calculate({ ...seed, investedUsd: '30', soldUsd: '0', realizedProfitUsd: '0', feesUsd: '0', feeInclusiveCapitalUsd: '30',
      lots: [{ tokenAmount: '10', costBasisUsd: '10' }, { tokenAmount: '10', costBasisUsd: '20' }] }, [event('101', 'sell', '30', '10')], '10');
    expect(result.positions[0]).toMatchObject({ realizedProfitUsd: '20', remainingCostBasisUsd: '20', estimatedProfitUsd: '20' });
    expect(result.closingLots?.[0].lots).toEqual([{ tokenAmount: '10', costBasisUsd: '20' }]);
  });
  it('keeps unknown baseline purchase costs unavailable', () => {
    const result = calculate({ ...seed, investedUsd: null }, [], '0');
    expect(result.complete).toBe(false); expect(result.positions[0].estimatedProfitUsd).toBeNull(); expect(result.reasons).toContain('purchase_cost_unknown');
  });
  it('does not convert unknown imported aggregate fees into a complete zero-fee result', () => {
    const result = calculate({ ...seed, feesUsd: null }, [], '0');
    expect(result.complete).toBe(false); expect(result.positions[0].estimatedProfitUsd).toBeNull(); expect(result.reasons).toContain('fees_incomplete');
  });
  it('never creates historical frame fees from the aggregate correction', () => {
    const result = calculate({ ...seed, feesUsd: '1295.59', realizedProfitUsd: '-1245.59' }, [event('101', 'buy', '10', '10')], '10');
    expect(result.timeline?.[0].snapshot.feesUsd).toBe('1295.59');
    expect(result.positions[0].estimatedProfitUsd).toBe('-1235.59');
    // The baseline starts at the checkpoint. Original imported rows are
    // evaluated independently for earlier replay frames by the adapter.
  });
  it('keeps an independently complete baseline total available without inventing FIFO fee allocation', () => {
    const baseline = { ...seed, soldUsd: '80', realizedProfitUsd: null, lots: [{ tokenAmount: '6', costBasisUsd: null }] };
    const result = calculate(baseline, [], '6');
    expect(result.positions[0]).toMatchObject({ complete: true, estimated: true, estimatedProfitUsd: '-10', realizedProfitUsd: null,
      remainingCostBasisUsd: null, unrealizedProfitUsd: null, feeInclusiveCapitalUsd: '101', reasons: ['fifo_allocation_unknown'] });
    expect(result.closingLots?.[0].lots).toEqual(baseline.lots);
    const continued = calculate(baseline, [{ ...event('101', 'sell', '5', '2'), feeUsd: '0.2' }], '4');
    expect(continued.positions[0]).toMatchObject({ complete: true, estimatedProfitUsd: '-9.2', realizedProfitUsd: null, remainingCostBasisUsd: null });
    expect(continued.timeline?.[0].snapshot.complete, 'Unknown allocation never makes earlier prefix frames verified').toBe(false);
  });
  it('does not use the allocation-only ending path for unknown cash costs, fees, quantity or missing acquisitions', () => {
    const baseline = { ...seed, soldUsd: '80', realizedProfitUsd: null, lots: [{ tokenAmount: '6', costBasisUsd: null }] };
    for (const invalid of [{ ...baseline, investedUsd: null }, { ...baseline, incomingTransferCostUsd: null }, { ...baseline, feesUsd: null }]) {
      expect(calculate(invalid, [], '6').positions[0].estimatedProfitUsd).toBeNull();
    }
    expect(calculate(baseline, [], '7').positions[0].estimatedProfitUsd).toBeNull();
    expect(calculate(baseline, [event('101', 'sell', '20', '8')], '0').positions[0].estimatedProfitUsd).toBeNull();
  });
  it('identifies fully closed cash-flow profit as realized after all baseline lots are disposed', () => {
    const baseline = { ...seed, soldUsd: '80', realizedProfitUsd: null, lots: [{ tokenAmount: '6', costBasisUsd: null }] };
    const result = calculate(baseline, [event('101', 'sell', '20', '6')], '0');
    expect(result.positions[0]).toMatchObject({ state: 'closed', complete: true, estimatedProfitUsd: '-2', realizedProfitUsd: '-2' });
  });
});
describe('node execution normalization', () => {
  it('uses exact raw quantities and persisted quote conversion without a provider', async () => {
    const market = { priceAt: vi.fn(async (asset: string) => ({ ...quote, tokenAddress: asset, priceUsd: '600' })) };
    const normalized = await normalizeNodeExecutionFlows([flow()], token, market);
    expect(normalized.events[0]).toMatchObject({ kind: 'buy', tokenAmount: '10', amountUsd: '600', feeUsd: '0.6', feeId: 'exec', blockNumber: '100' });
    expect(normalized.reasons).toEqual([]); expect(market.priceAt).toHaveBeenCalledOnce();
  });
  it('keeps multiple smart-account operations in the same transaction distinct', async () => {
    const market = { priceAt: vi.fn(async () => ({ ...quote, priceUsd: '600' })) };
    const one = flow({ id: 'op1', operation_hash: 'op1', kind: 'user_operation', execution_index: 0 });
    const two = flow({ id: 'op2', operation_hash: 'op2', kind: 'user_operation', execution_index: 1 });
    const normalized = await normalizeNodeExecutionFlows([one, two], token, market);
    expect(normalized.events.map(row => row.id)).toEqual([`op1:${token}`, `op2:${token}`]);
    expect(normalized.events.map(row => row.feeId)).toEqual(['op1', 'op2']); expect(normalized.events.map(row => row.logIndex)).toEqual([0, 1]);
  });
  it('never assumes decimals or a quote asset ticker is worth one dollar', async () => {
    const market = { priceAt: vi.fn(async () => ({ ...quote, priceUsd: null })) };
    const unpriced = await normalizeNodeExecutionFlows([flow()], token, market);
    expect(unpriced.events[0].amountUsd).toBeNull(); expect(unpriced.reasons).toContain('execution_valuation_unavailable');
    const unknown = await normalizeNodeExecutionFlows([flow({ decimals: null })], token, market);
    expect(unknown.events).toEqual([]); expect(unknown.reasons).toContain('token_decimals_unknown');
  });
  it('waits for actual native spend evidence rather than charging a gross value that may be refunded',async()=>{
    const market={priceAt:vi.fn(async()=>({...quote,priceUsd:'600'}))};
    const pending=await normalizeNodeExecutionFlows([flow({trace:null})],token,market);
    expect(pending.events[0].amountUsd).toBeNull();expect(pending.reasons).toContain('native_trace_required');
    const refunded=await normalizeNodeExecutionFlows([flow({trace:{type:'CALL',from:wallet,to:token,value:'0xde0b6b3a7640000',
      calls:[{type:'CALL',from:token,to:wallet,value:'0x6f05b59d3b20000'}]}})],token,market);
    expect(refunded.events[0].amountUsd).toBe('300');expect(refunded.events[0].feeUsd).toBe('0.6');
  });
  it('keeps unsupported execution attribution explicit instead of treating its transfers as a valid swap', async () => {
    const result = await normalizeNodeExecutionFlows([flow({ status: 'unsupported' })], token, { priceAt: vi.fn(async () => quote) });
    expect(result.events).toEqual([]); expect(result.reasons).toContain('unsupported_execution_decoder');
  });
  it('uses the authenticated Binance transaction recipient to verify net native income',async()=>{
    const router='0xb300000b72deaeb607a12d5f54773d1c19c7028d',outputRouter='0x3d90f66b534dd8482b181e24655a9e8265316be9';
    const word=(value:string|bigint)=>typeof value==='string'?value.slice(2).padStart(64,'0'):value.toString(16).padStart(64,'0');
    const sold=10n*10n**18n,gross=200000000000000000n,fee=20000000000000000n;
    const logs=[{address:outputRouter,topics:['0xe5b9f85c5caca875a8b78e5b2d88de86d7793cbff3d81ea4ecbec4c2b9ad7beb'],
      data:'0x'+[0n,token,`0x${'0'.repeat(40)}`,wallet,sold,gross].map(word).join('')},
      {address:router,topics:['0xf228de527fc1b9843baac03b9a04565473a263375950e63435d4138464386f46','0x'+'0'.repeat(64)],data:'0x'+[0n,fee].map(word).join('')},
      {address:wbnb,topics:['0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65','0x'+word('0x52b7b9e768900e2cc509ff0109b900660431b5d7')],data:'0x'+word(gross)}];
    const sale=flow({native_value_raw:'0',delta_raw:`-${sold}`,fee_native_wei:'0',transaction_to:router,trace:null,logs});
    const market={priceAt:vi.fn(async()=>({...quote,priceUsd:'1000'}))};
    expect((await normalizeNodeExecutionFlows([sale],token,market)).events[0].amountUsd).toBe('180');
    for(const transaction_to of [null,token,'0x9689992f5b5c09447f15906d8d11214944488341'])
      expect((await normalizeNodeExecutionFlows([{...sale,transaction_to}],token,market)).events[0].amountUsd).toBeNull();
    expect((await normalizeNodeExecutionFlows([{...sale,kind:'user_operation'}],token,market)).events[0].amountUsd).toBeNull();
    const wrongRecipient=structuredClone(sale);wrongRecipient.logs[0].data='0x'+[0n,token,`0x${'0'.repeat(40)}`,token,sold,gross].map(word).join('');
    expect((await normalizeNodeExecutionFlows([wrongRecipient],token,market)).events[0].amountUsd).toBeNull();
  });
  it('values incoming transfers on receipt and never charges the sender gas to the recipient', async () => {
    const market = { priceAt: vi.fn(async () => quote) };
    const result = await normalizeNodeExecutionFlows([flow({ kind: 'transfer', fee_native_wei: '0', logs: [], counterparties: [wbnb] })], token, market);
    expect(result.events[0]).toMatchObject({ kind: 'transfer_in', amountUsd: '20', feeUsd: '0', counterparty: wbnb, transferId: `${blockHash}:${token}:1` });
  });
  it('uses an authenticated eligible quote leg and assigns an exchange fee once across both token positions', async () => {
    const quoteToken = `0x${'c'.repeat(40)}`, contract = `0x${'d'.repeat(40)}`;
    const registry: NodeMarketIdentity = { id: 'registered-pair', token, quote: quoteToken, protocol: 'pcs_v2', contract, poolId: null,
      token0: token, token1: quoteToken, decimals0: 18, decimals1: 18, authentication: { factory: PCS_V2_FACTORY } };
    const encoded = poolMarketAbi.encodeEventLog(poolMarketAbi.getEvent('Swap')!, [wallet, 0n, 5n * 10n ** 18n, 10n * 10n ** 18n, 0n, wallet]);
    const base = flow({ native_value_raw: '0', logs: [{ address: contract, ...encoded }], authenticated_markets: [registry] });
    const other = { ...base, token_address: quoteToken, delta_raw: '-5000000000000000000' };
    const market = { priceAt: vi.fn(async (asset: string) => ({ ...quote, tokenAddress: asset, priceUsd: asset === quoteToken ? '3' : '600' })) };
    const acquired = await normalizeNodeExecutionFlows([base, other], token, market), disposed = await normalizeNodeExecutionFlows([base, other], quoteToken, market);
    expect(acquired.reasons).toEqual([]); expect(disposed.reasons).toEqual([]);
    expect(acquired.events[0]).toMatchObject({ kind: 'buy', amountUsd: '15', feeUsd: '0.6' });
    expect(disposed.events[0]).toMatchObject({ kind: 'sell', amountUsd: '15', feeUsd: '0' });
    const combined = calculateJournalLedger({ wallets: [wallet], events: [...acquired.events, ...disposed.events], asOf: stamp,
      coverage: [token, quoteToken].map(tokenAddress => ({ walletAddress: wallet, tokenAddress, complete: true })),
      baselines: [{ ...seed, tokenAddress: quoteToken, investedUsd: '10', soldUsd: '0', realizedProfitUsd: '0', feesUsd: '0', feeInclusiveCapitalUsd: '10', lots: [{ tokenAmount: '5', costBasisUsd: '10' }] }],
      valuations: [{ tokenAddress: token, priceUsd: '2', pricedAt: stamp, balances: [{ walletAddress: wallet, tokenAmount: '10' }] },
        { tokenAddress: quoteToken, priceUsd: '3', pricedAt: stamp, balances: [{ walletAddress: wallet, tokenAmount: '0' }] }] });
    expect(combined.complete).toBe(true); expect(combined.totals.feesUsd).toBe('0.6'); expect(combined.totals.estimatedProfitUsd).toBe('9.4');
    for (const altered of [
      [{ ...base, authenticated_markets: [{ ...registry, authentication: { factory: token } }] }, other],
      [{ ...base, logs: [...base.logs, ...base.logs] }, other],
      [base, { ...other, delta_raw: '-6000000000000000000' }],
      [{ ...base, native_value_raw: '1' }, other],
      [base, { ...other, decimals: 6 }],
    ]) {
      const unknown = await normalizeNodeExecutionFlows(altered, token, market);
      expect(unknown.events[0].amountUsd).toBeNull(); expect(unknown.reasons).toContain('shared_quote_unallocated');
    }
  });
});
describe('database snapshot isolation and bounded requests', () => {
  it('requires contiguous completed post-baseline ranges without needing pruned earlier ranges', () => {
    expect(nodeAccountingRangesComplete('100', '200', [{ fromBlock: '101', toBlock: '160' }, { fromBlock: '161', toBlock: '200' }])).toBe(true);
    expect(nodeAccountingRangesComplete('100', '200', [{ fromBlock: '101', toBlock: '160' }, { fromBlock: '162', toBlock: '200' }])).toBe(false);
    expect(nodeAccountingRangesComplete('100', '100', [])).toBe(true);
    expect(nodeAccountingRangesComplete('100', '200', [{ fromBlock: '150', toBlock: '200' }])).toBe(false);
  });
  it('requires authentic token creation after registration, rather than a new pool or a provider launch date', () => {
    const encoded = fourInterface.encodeEventLog(fourInterface.getEvent('TokenCreate')!, [wallet, token, 1n, 'Test', 'TEST', 1000n, 1n, 0n]);
    const log = { address: FOUR_MANAGERS[0], ...encoded };
    expect(authenticNodeTokenCreation(token, '100', '200', [{ blockNumber: '150', logs: [log] }])).toBe(true);
    expect(authenticNodeTokenCreation(token, '100', '200', [{ blockNumber: '99', logs: [log] }])).toBe(false);
    expect(authenticNodeTokenCreation(token, '100', '200', [{ blockNumber: '150', logs: [{ ...log, address: token }] }])).toBe(false);
    const migrated = fourInterface.encodeEventLog(fourInterface.getEvent('LiquidityAdded')!, [token, 100n, wbnb, 2n]);
    expect(authenticNodeTokenCreation(token, '100', '200', [{ blockNumber: '150', logs: [{ address: FOUR_MANAGERS[0], ...migrated }] }])).toBe(false);
  });
  it('reads all six summaries in a single query without balance or upstream work', async () => {
    const selected = Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(40)}`), balance = vi.fn();
    const query = vi.fn(async (sql: string) => sql.startsWith('SELECT 1 FROM kols') ? { rowCount: 1, rows: [{}] }
      : sql.includes('SELECT token_address,summary') ? { rows: selected.map(token_address => ({ token_address, summary: { status: 'ready' }, as_of: stamp })) } : { rows: [] });
    const service = createNodeAccountingService({ db: { query } as unknown as Pool, market: { quote: vi.fn(), priceAt: vi.fn() }, balance, now: () => Date.parse(stamp) });
    expect(Object.keys(await service.summaries(wallet, selected))).toHaveLength(6);
    expect(query.mock.calls.filter(call => call[0].includes('SELECT token_address,summary'))).toHaveLength(1); expect(balance).not.toHaveBeenCalled();
  });
  it('promotes the visible summary batch above background work without replacing selected work or cooldowns',async()=>{
    const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT 1 FROM kols')?{rowCount:1,rows:[{}]}:{rows:[]});
    const balance=vi.fn(),service=createNodeAccountingService({db:{query}as unknown as Pool,market:{quote:vi.fn(),priceAt:vi.fn()},balance});
    await service.summaries(wallet,[token]);
    const sql=query.mock.calls.find(([sql])=>sql.includes('INSERT INTO node_accounting_jobs'))?.[0]??'';
    expect(sql).toContain('scope,priority');expect(sql).toContain('jsonb,10');
    expect(sql).toContain('GREATEST(node_accounting_jobs.priority,EXCLUDED.priority)');
    expect(sql).not.toContain('next_attempt_at=');expect(sql).not.toContain('lease_id=');expect(balance).not.toHaveBeenCalled();
    const quotes=query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO node_market_refresh_jobs'));
    expect(quotes).toHaveLength(1);expect(quotes[0][0]).toContain('token,5,now()');
    expect(quotes[0][0]).toContain('GREATEST(node_market_refresh_jobs.priority,EXCLUDED.priority)');
    const history=query.mock.calls.filter(([sql])=>sql.includes('UPDATE node_import_jobs'));
    expect(history).toHaveLength(1);expect(history[0][0]).toContain('GREATEST(j.priority,20)');
    expect(history[0][0]).toContain("stage IN('history','aggregate','reconcile')");
    expect(history[0][0]).toContain('b.checkpoint_block>=m.registration_block');
    expect(history[0][0]).not.toContain('next_attempt_at=');expect(history[0][0]).not.toContain('lease_id=');
  });
  it('never promotes public provider recovery from private portfolio summaries',async()=>{
    const query=vi.fn(async(_sql:string)=>({rowCount:1,rows:[]}));
    const service=createNodeAccountingService({db:{query}as unknown as Pool,market:{quote:vi.fn(),priceAt:vi.fn()},balance:vi.fn()});
    await service.summaries(wallet,[token],{kind:'portfolio',accountId:'a',membershipRevision:'b',fromAt:stamp,fromBlock:'100'});
    expect(query.mock.calls.some(call=>String(call[0]).includes('UPDATE node_import_jobs'))).toBe(false);
  });
  it.each(['unchanged','new_history','new_cost','changed_balance','missing_proof','invalidated'])('retains aggregate-ending profit through a quote delay only for unchanged evidence (%s)',async(change)=>{
    const identity={version:2,snapshotId:'saved',source:'imported',scope:'public',asOf:stamp,historyFingerprint:'same-history',complete:true,reasons:['fifo_allocation_unknown']};
    const position={remainingTokenAmount:'10',feeInclusiveCostUsd:'101',estimatedProfitUsd:'78',estimatedRoi:'0.772277',cashFlow:{investedUsd:'100',soldUsd:'150',transferOutIncomeUsd:'0',feesUsd:'2'}};
    const known={token:{address:token},accountingSnapshot:identity,realizedAccounting:{walletAddress:wallet,tokenAddress:token,position,
      coverage:{transactionsComplete:true,balanceMatched:true,balanceProof:{balance:'10'}}}} as unknown as KolTokenActivity;
    const current=structuredClone(known);current.accountingSnapshot={...identity,snapshotId:'pending',complete:false,
      reasons:['purchase_cost_unknown','quote_unavailable','realized_cost_unknown']} as KolTokenActivity['accountingSnapshot'];
    current.realizedAccounting!.position!.estimatedProfitUsd=null;
    if(change==='new_history')current.accountingSnapshot!.historyFingerprint='new-history';
    if(change==='new_cost')current.realizedAccounting!.position!.cashFlow!.investedUsd='101';
    if(change==='changed_balance')current.realizedAccounting!.coverage.balanceProof!.balance='11';
    if(change==='missing_proof'){delete current.realizedAccounting!.coverage.balanceProof;delete known.realizedAccounting!.coverage.balanceProof;}
    const row={payload:current,last_valid:known,complete:false,as_of:stamp,invalidated_at:change==='invalidated'?stamp:null};
    const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT 1 FROM kols')?{rowCount:1,rows:[{}]}
      :sql.includes('SELECT payload,as_of,complete,last_valid')?{rows:[row]}:{rows:[]});
    const service=createNodeAccountingService({db:{query}as unknown as Pool,market:{quote:vi.fn(),priceAt:vi.fn()},balance:vi.fn(),now:()=>Date.parse(stamp)});
    const result=await service.activity({wallet,token});
    if(change==='unchanged'){
      expect(result?.accountingSnapshot).toMatchObject({snapshotId:'saved',asOf:stamp,refreshStatus:'pending',refreshReason:'quote_unavailable'});
      expect(result?.realizedAccounting?.position?.estimatedProfitUsd).toBe('78');
    }else expect(result?.accountingSnapshot?.snapshotId).not.toBe('saved');
  });
  it('rejects a stale/removed private membership before reading shared snapshots', async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] })), balance = vi.fn();
    const service = createNodeAccountingService({ db: { query } as unknown as Pool, market: { quote: vi.fn(), priceAt: vi.fn() }, balance });
    expect(await service.activity({ wallet, token, scope: { kind: 'portfolio', accountId: 'a', membershipRevision: 'b', fromAt: stamp, fromBlock: '100' } })).toBeUndefined();
    expect(query).toHaveBeenCalledOnce(); expect(balance).not.toHaveBeenCalled();
  });
  it('includes account, selected boundary and revision in private identities', () => {
    const scope = { kind: 'portfolio' as const, accountId: 'a', membershipRevision: 'b', fromAt: stamp, fromBlock: '100' };
    expect(nodeAccountingScopeKey(scope)).not.toBe(nodeAccountingScopeKey({ ...scope, accountId: 'other' }));
    expect(nodeAccountingScopeKey(scope)).not.toBe(nodeAccountingScopeKey({ ...scope, membershipRevision: 'new' }));
    expect(nodeAccountingScopeKey(scope)).not.toBe(nodeAccountingScopeKey({ ...scope, fromBlock: '101' }));
  });
  it('invalidates orphaned evidence, baselines and saved valuations on reorg', async () => {
    const query = vi.fn(async () => ({ rows: [] })); await rollbackNodeAccounting({ query } as unknown as Pool, '100');
    expect(query.mock.calls).toHaveLength(6); expect(query.mock.calls.every(call => (call as unknown[])[1] instanceof Array)).toBe(true);
    expect(query.mock.calls.some(call => (call as unknown[])[0] === "UPDATE leaderboard_snapshots SET node_accounting=NULL WHERE period='1d' AND node_accounting IS NOT NULL")).toBe(true);
  });
  it('rejects contradictory imported opening quantities before a database mutation', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(saveNodeAccountingBaseline({ query } as unknown as Pool, { wallet, token, checkpoint: { walletAddress: wallet, tokenAddress: token, chain: 'bsc', blockNumber: '100', blockHash,
      blockTimestamp: stamp, checkedAt: stamp, balance: '2' }, ledger: { ...seed, lots: [] }, historyFingerprint: 'a'.repeat(64), overlapVerified: true, quantityVerified: true })).rejects.toThrow('baseline_quantity_unreconciled');
    expect(query).not.toHaveBeenCalled();
  });
  it.each([{ monitoringRows: [] }, { monitoringRows: [{ registration_block: null }] }])('reports pending monitoring before an import baseline can be saved ($monitoringRows)', async ({ monitoringRows }) => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT registration_block::text') ? monitoringRows : [] }));
    const { walletAddress: _wallet, tokenAddress: _token, ...ledger } = seed;
    await expect(saveNodeAccountingBaseline({ query } as unknown as Pool, { wallet, token,
      checkpoint: { walletAddress: wallet, tokenAddress: token, chain: 'bsc', blockNumber: '100', blockHash, blockTimestamp: stamp, checkedAt: stamp, balance: '0' },
      ledger, historyFingerprint: 'a'.repeat(64), overlapVerified: true, quantityVerified: true })).rejects.toThrow('baseline_monitoring_pending');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO node_accounting_baselines'))).toBe(false);
  });
});
