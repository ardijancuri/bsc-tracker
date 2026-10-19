/** Source-neutral exact-decimal accounting. Public and private positions use
 * this engine; source adapters provide evidence, never financial calculations. */
export interface JournalLedgerEvent {
  id: string; walletAddress: string; tokenAddress: string;
  kind: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
  tokenAmount: string; amountUsd: string | null;
  /** A wallet-paid fee, never the whole bundler transaction fee. */
  feeUsd?: string | null; feeId?: string;
  txHash: string; timestamp: string; blockNumber?: string | null;
  transactionIndex?: number | null; logIndex?: number | null;
  counterparty?: string | null; transferId?: string | null;
}
/** Holdings present when tracking started. Their old acquisition cost is not
 * recovered or presented as tracked-period investment. */
export interface JournalLedgerBaseline {
  walletAddress: string; tokenAddress: string;
  investedUsd: string | null; soldUsd: string | null; incomingTransferCostUsd: string | null; transferOutIncomeUsd: string | null;
  realizedProfitUsd: string | null; feesUsd: string | null; feeInclusiveCapitalUsd: string | null;
  lots: { tokenAmount: string; costBasisUsd: string | null }[];
}
export interface JournalLedgerOpeningBalance {
  walletAddress: string; tokenAddress: string; tokenAmount: string;
}
export interface JournalLedgerCoverage {
  walletAddress: string; tokenAddress: string; complete: boolean; reason?: string;
  /** Quantities can be complete while historical USD/fee valuation is pending. */
  quantitiesComplete?: boolean;
}
export interface JournalLedgerValuation {
  tokenAddress: string; priceUsd: string | null; pricedAt: string;
  balances: { walletAddress: string; tokenAmount: string; tolerance?: string }[];
}
export interface JournalLedgerPosition {
  tokenAddress: string; wallets: string[]; state: 'open' | 'closed' | 'unknown';
  remainingTokenAmount: string | null; remainingCostBasisUsd: string | null;
  valueUsd: string | null; investedUsd: string | null; soldUsd: string | null;
  incomingTransferCostUsd: string | null; transferOutIncomeUsd: string | null;
  realizedProfitUsd: string | null; unrealizedProfitUsd: string | null;
  estimatedProfitUsd: string | null; roi: string | null;
  feeInclusiveCapitalUsd: string | null; feesUsd: string; pricedAt: string | null;
  complete: boolean; estimated: boolean; reasons: string[];
}
export interface JournalLedgerResult {
  wallets: string[]; asOf: string; positions: JournalLedgerPosition[]; complete: boolean; reasons: string[];
  totals: { valueUsd: string | null; investedUsd: string | null; soldUsd: string | null;
    realizedProfitUsd: string | null; estimatedProfitUsd: string | null; roi: string | null;
    feeInclusiveCapitalUsd: string | null; feesUsd: string };
  timeline?: JournalLedgerTimelineEntry[];
  /** Realized changes inside a dated window, calculated from the same lifetime FIFO. */
  period?: JournalLedgerPeriodResult;
  /** Internal exact FIFO handoff; adapters omit this from public JSON. */
  closingLots?: { walletAddress: string; tokenAddress: string; lots: { tokenAmount: string; costBasisUsd: string | null }[] }[];
}
export interface JournalLedgerPeriodPosition {
  tokenAddress: string;
  realizedProfitUsd: string | null; knownRealizedProfitUsd: string;
  closedBaselineFeesUsd: string;
  valuedSellCount: number; excludedSellCount: number;
  valuedTransferOutCount: number; excludedTransferOutCount: number;
  complete: boolean; reasons: string[];
}
export interface JournalLedgerPeriodResult {
  wallets: string[]; from: string; to: string;
  positions: JournalLedgerPeriodPosition[]; complete: boolean; reasons: string[];
  totals: Omit<JournalLedgerPeriodPosition, 'tokenAddress'> & {
    feeOnlyFeesUsd: string | null; valuedFeeCount: number; excludedFeeCount: number;
  };
}
/** Failed transactions can pay a fee without creating a token movement. The
 * adapter must authenticate the payer, including smart-account operation fees. */
export interface JournalLedgerPeriodFeeEvent {
  id: string; walletAddress: string; txHash: string; feeId?: string;
  timestamp: string; feeUsd: string | null;
  /** Authenticated EOA payer fee. Never set for a bundler/user operation. */
  transactionScoped?: boolean;
}
/** Only an adapter with a reconciled canonical checkpoint and verified complete
 * lifetime pagination can authorize this internal whole-cycle contribution.
 * It applies to one public wallet, never consolidated Portfolio transfers. */
export interface JournalLedgerPeriodClosedBaseline {
  walletAddress: string; tokenAddress: string; scope: 'lifetime';
  checkpointTimestamp: string; checkpointBlock: string; checkpointHash: string;
  balance: string; verified: true; historyComplete: true; historyFingerprint: string;
  baseline: JournalLedgerBaseline; events: JournalLedgerEvent[];
}
export interface JournalLedgerInput {
  wallets: string[]; events: JournalLedgerEvent[]; valuations: JournalLedgerValuation[];
  coverage: JournalLedgerCoverage[]; openingBalances?: JournalLedgerOpeningBalance[]; baselines?: JournalLedgerBaseline[];
  asOf: string; timeline?: boolean;
  /** Inclusive boundaries. Equal-timestamp movements are never split between windows. */
  period?: { from: string; to: string };
  periodFeeEvents?: JournalLedgerPeriodFeeEvent[];
  periodClosedBaselines?: JournalLedgerPeriodClosedBaseline[];
}
export interface JournalLedgerTimelineEntry {
  tokenAddress: string; timestamp: string; eventIds: string[];
  snapshot: Pick<JournalLedgerPosition, 'remainingTokenAmount' | 'remainingCostBasisUsd' | 'realizedProfitUsd' | 'investedUsd' | 'soldUsd'
    | 'incomingTransferCostUsd' | 'transferOutIncomeUsd' | 'feesUsd' | 'feeInclusiveCapitalUsd' | 'complete' | 'reasons'>;
}

// Rational arithmetic preserves every parsed decimal and every FIFO split.
// Rounding occurs only at the JSON boundary (36 decimal places).
const gcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left, b = right < 0n ? -right : right;
  while (b) { const next = a % b; a = b; b = next; } return a || 1n;
};
class Decimal {
  readonly n: bigint; readonly d: bigint;
  constructor(n: bigint, d = 1n) {
    if (d === 0n) throw new Error('decimal_division_by_zero');
    const divisor = gcd(n, d); this.n = n / divisor * (d < 0n ? -1n : 1n); this.d = (d < 0n ? -d : d) / divisor;
  }
  static parse(value: unknown): Decimal | null {
    if (typeof value !== 'string' || value.length > 512) return null;
    const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
    if (!match) return null;
    const exponent = Number(match[4] || 0), digits = match[2] + (match[3] || '');
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 256 || digits.length > 256) return null;
    const scale = (match[3]?.length || 0) - exponent;
    return new Decimal(BigInt(`${match[1] === '-' ? '-' : ''}${digits}`) * (scale < 0 ? 10n ** BigInt(-scale) : 1n), scale > 0 ? 10n ** BigInt(scale) : 1n);
  }
  add(other: Decimal) { return new Decimal(this.n * other.d + other.n * this.d, this.d * other.d); }
  sub(other: Decimal) { return new Decimal(this.n * other.d - other.n * this.d, this.d * other.d); }
  mul(other: Decimal) { return new Decimal(this.n * other.n, this.d * other.d); }
  div(other: Decimal) { return new Decimal(this.n * other.d, this.d * other.n); }
  cmp(other: Decimal) { const value = this.n * other.d - other.n * this.d; return value < 0n ? -1 : value > 0n ? 1 : 0; }
  abs() { return this.n < 0n ? new Decimal(-this.n, this.d) : this; }
  text() {
    const scale = 10n ** 36n, absolute = this.n < 0n ? -this.n : this.n;
    let raw = absolute * scale / this.d;
    if (absolute * scale % this.d * 2n >= this.d) raw++;
    const whole = raw / scale, fraction = (raw % scale).toString().padStart(36, '0').replace(/0+$/, '');
    return `${this.n < 0n && raw ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  }
}
const zero = new Decimal(0n), positive = (value: Decimal | null): value is Decimal => value != null && value.cmp(zero) > 0;
const nonnegative = (value: unknown) => { const parsed = Decimal.parse(value); return parsed && parsed.cmp(zero) >= 0 ? parsed : null; };
export function sumJournalDecimals(values: string[]) {
  return values.reduce((total, value) => {
    const parsed = Decimal.parse(value); if (!parsed) throw new Error('invalid_decimal'); return total.add(parsed);
  }, zero).text();
}
export function journalDecimalMultiply(left: string, right: string): string | null {
  const a = Decimal.parse(left), b = Decimal.parse(right); return a && b ? a.mul(b).text() : null;
}
export function journalDecimalDivide(left: string, right: string): string | null {
  const a = Decimal.parse(left), b = Decimal.parse(right); return a && b && b.cmp(zero) !== 0 ? a.div(b).text() : null;
}
type Lot = { quantity: Decimal; cost: Decimal | null; acquiredOrder: number; acquisition: JournalLedgerEvent | null; feeKnown: boolean };
type Event = JournalLedgerEvent & { quantity: Decimal; amount: Decimal | null; fee: Decimal | null };
function knownOrder(left: JournalLedgerEvent, right: JournalLedgerEvent) {
  if (left.blockNumber != null && right.blockNumber != null && /^\d+$/.test(left.blockNumber) && /^\d+$/.test(right.blockNumber)) {
    const a = BigInt(left.blockNumber), b = BigInt(right.blockNumber);
    if (a !== b) return a < b ? -1 : 1;
    if (left.transactionIndex != null && right.transactionIndex != null && left.transactionIndex !== right.transactionIndex) return left.transactionIndex - right.transactionIndex;
    if (left.txHash === right.txHash && left.logIndex != null && right.logIndex != null) return left.logIndex - right.logIndex;
  }
  return Date.parse(left.timestamp) - Date.parse(right.timestamp);
}
function hasExecutionOrder(left: JournalLedgerEvent, right: JournalLedgerEvent) {
  return left.blockNumber != null && right.blockNumber != null && (left.blockNumber !== right.blockNumber
    || left.transactionIndex != null && right.transactionIndex != null && left.transactionIndex !== right.transactionIndex
    || left.txHash === right.txHash && left.logIndex != null && right.logIndex != null && left.logIndex !== right.logIndex);
}
const sameEvent = (left: JournalLedgerEvent, right: JournalLedgerEvent) => left.kind === right.kind && left.tokenAmount === right.tokenAmount
  && left.amountUsd === right.amountUsd && left.feeUsd === right.feeUsd && left.txHash === right.txHash && left.timestamp === right.timestamp;

/** Match the existing historical import's bounded FX/display rounding. This
 * validates retained rows against an already verified aggregate, not new costs. */
function closedMoneyMatches(left: Decimal, right: Decimal) {
  const relative = (left.abs().cmp(right.abs()) > 0 ? left.abs() : right.abs()).mul(Decimal.parse('0.000001')!);
  const maximum = Decimal.parse('0.01')!, minimum = Decimal.parse('0.00000001')!;
  const bound = relative.cmp(maximum) > 0 ? maximum : relative.cmp(minimum) < 0 ? minimum : relative;
  return left.sub(right).abs().cmp(bound) <= 0;
}
function closedPeriodContribution(candidate: JournalLedgerPeriodClosedBaseline, input: JournalLedgerInput, wallets: string[]) {
  const wallet = candidate.walletAddress?.toLowerCase(), token = candidate.tokenAddress?.toLowerCase(), checkpoint = Date.parse(candidate.checkpointTimestamp);
  const from = Date.parse(input.period?.from ?? ''), to = Date.parse(input.period?.to ?? ''), baseline = candidate.baseline;
  if (wallets.length !== 1 || wallet !== wallets[0] || candidate.scope !== 'lifetime' || candidate.verified !== true || candidate.historyComplete !== true
    || !/^[a-f0-9]{64}$/.test(candidate.historyFingerprint ?? '') || !/^\d+$/.test(candidate.checkpointBlock ?? '')
    || !/^0x[a-f0-9]{64}$/.test(candidate.checkpointHash ?? '') || !Number.isFinite(checkpoint) || checkpoint < from || checkpoint > to
    || nonnegative(candidate.balance)?.cmp(zero) !== 0 || !baseline || baseline.walletAddress?.toLowerCase() !== wallet || baseline.tokenAddress?.toLowerCase() !== token
    || !Array.isArray(baseline.lots) || baseline.lots.length !== 0 || !Array.isArray(candidate.events) || candidate.events.length === 0) return null;
  const invested = nonnegative(baseline.investedUsd), sold = nonnegative(baseline.soldUsd), incoming = nonnegative(baseline.incomingTransferCostUsd),
    outgoing = nonnegative(baseline.transferOutIncomeUsd), fees = nonnegative(baseline.feesUsd), capital = nonnegative(baseline.feeInclusiveCapitalUsd), profit = Decimal.parse(baseline.realizedProfitUsd);
  if (!invested || !sold || !incoming || !outgoing || !fees || !capital || !profit || capital.cmp(invested.add(incoming)) < 0
    || capital.cmp(invested.add(incoming).add(fees)) > 0 || profit.cmp(sold.add(outgoing).sub(invested).sub(incoming).sub(fees)) !== 0) return null;
  const amounts = { buy: zero, sell: zero, transfer_in: zero, transfer_out: zero }, unique = new Map<string, JournalLedgerEvent>(), knownFees = new Map<string, Decimal>();
  let quantity = zero;
  for (const event of candidate.events) {
    const instant = Date.parse(event.timestamp), units = nonnegative(event.tokenAmount), amount = nonnegative(event.amountUsd);
    if (event.walletAddress?.toLowerCase() !== wallet || event.tokenAddress?.toLowerCase() !== token || !Object.hasOwn(amounts, event.kind)
      || !Number.isFinite(instant) || instant < from || instant > checkpoint || !positive(units) || !amount
      || event.blockNumber != null && (!/^\d+$/.test(event.blockNumber) || BigInt(event.blockNumber) > BigInt(candidate.checkpointBlock))) return null;
    const previous = unique.get(event.id);
    if (previous) { if (!sameEvent(previous, event)) return null; continue; }
    unique.set(event.id, event);
    amounts[event.kind] = amounts[event.kind].add(amount);
    quantity = quantity.add(event.kind === 'sell' || event.kind === 'transfer_out' ? zero.sub(units) : units);
    const fee = nonnegative(event.feeUsd), feeKey = `${wallet}:${event.feeId || event.txHash.toLowerCase()}`, priorFee = knownFees.get(feeKey);
    if (fee && priorFee && fee.cmp(priorFee) !== 0) return null;
    if (fee) knownFees.set(feeKey, fee);
  }
  if (quantity.cmp(zero) !== 0 || !closedMoneyMatches(amounts.buy, invested) || !closedMoneyMatches(amounts.sell, sold)
    || !closedMoneyMatches(amounts.transfer_in, incoming) || !closedMoneyMatches(amounts.transfer_out, outgoing)
    || [...knownFees.values()].reduce((sum, value) => sum.add(value), zero).cmp(fees) > 0) return null;
  // A retained aggregate and its original movements cannot both contribute.
  if ((input.baselines ?? []).some(row => row.walletAddress.toLowerCase() === wallet && row.tokenAddress.toLowerCase() === token)
    || (input.openingBalances ?? []).some(row => row.walletAddress.toLowerCase() === wallet && row.tokenAddress.toLowerCase() === token && nonnegative(row.tokenAmount)?.cmp(zero) !== 0)
    || input.events.some(event => event.walletAddress.toLowerCase() === wallet && event.tokenAddress.toLowerCase() === token
      && (!event.blockNumber || !/^\d+$/.test(event.blockNumber) || BigInt(event.blockNumber) <= BigInt(candidate.checkpointBlock)
        || Date.parse(event.timestamp) < checkpoint))) return null;
  return { profit, fees, knownFees, token, events: [...unique.values()], sells: [...unique.values()].filter(event => event.kind === 'sell').length,
    outs: [...unique.values()].filter(event => event.kind === 'transfer_out').length };
}

export function calculateJournalLedger(input: JournalLedgerInput): JournalLedgerResult {
  const periodFrom = input.period ? Date.parse(input.period.from) : NaN, periodTo = input.period ? Date.parse(input.period.to) : NaN;
  if (input.period && (!Number.isFinite(periodFrom) || !Number.isFinite(periodTo) || !Number.isFinite(Date.parse(input.asOf)) || periodFrom > periodTo || periodTo > Date.parse(input.asOf)))
    throw new Error('invalid_ledger_period');
  const wallets = [...new Set(input.wallets.map(wallet => wallet.toLowerCase()))].sort(), selected = new Set(wallets);
  const closedContributions = new Map<string, NonNullable<ReturnType<typeof closedPeriodContribution>>>(), closedRejected = new Set<string>(), closedIdentities = new Map<string, string>();
  if (input.period) for (const candidate of input.periodClosedBaselines ?? []) {
    if (!selected.has(candidate.walletAddress?.toLowerCase())) continue;
    const token = candidate.tokenAddress.toLowerCase(), identity = JSON.stringify(candidate), existing = closedIdentities.get(token);
    if (existing === identity) continue;
    closedIdentities.set(token, identity);
    const contribution = existing ? null : closedPeriodContribution(candidate, input, wallets);
    if (!contribution || closedRejected.has(token)) { closedRejected.add(token); closedContributions.delete(token); }
    else closedContributions.set(token, contribution);
  }
  const rejected = new Map<string, Set<string>>(), unique = new Map<string, JournalLedgerEvent>();
  const reject = (token: string, reason: string) => { const reasons = rejected.get(token) || new Set<string>(); reasons.add(reason); rejected.set(token, reasons); };
  for (const row of input.events) {
    const walletAddress = row.walletAddress.toLowerCase(), tokenAddress = row.tokenAddress.toLowerCase();
    if (!selected.has(walletAddress)) continue;
    const instant = Date.parse(row.timestamp);
    // Equivalent ISO spellings identify one atomic instant, not a usable
    // execution order between provider movements.
    const event = { ...row, timestamp: Number.isFinite(instant) ? new Date(instant).toISOString() : row.timestamp,
      walletAddress, tokenAddress, txHash: row.txHash.toLowerCase(), counterparty: row.counterparty?.toLowerCase() };
    const key = `${walletAddress}:${tokenAddress}:${event.id}`, existing = unique.get(key);
    if (existing && !sameEvent(existing, event)) reject(tokenAddress, 'contradictory_event'); else if (!existing) unique.set(key, event);
  }
  const feeEvidence = new Map<string, { value: Decimal | null; token: string }>(), feesCharged = new Set<string>();
  const events = [...unique.values()].sort((a, b) => knownOrder(a, b) || a.id.localeCompare(b.id));
  // Fee identities are scoped to the payer; repeated operations may use distinct IDs.
  for (const event of events) {
    const key = `${event.walletAddress}:${event.feeId || event.txHash}`, fee = nonnegative(event.feeUsd);
    if (event.feeUsd === undefined) continue;
    const existing = feeEvidence.get(key);
    if (existing?.value && fee && existing.value.cmp(fee) !== 0) { reject(event.tokenAddress, 'contradictory_fee'); reject(existing.token, 'contradictory_fee'); }
    else if (!existing || !existing.value && fee) feeEvidence.set(key, { value: fee, token: event.tokenAddress });
  }
  const tokens = [...new Set([...events.map(event => event.tokenAddress), ...input.coverage.filter(row => selected.has(row.walletAddress.toLowerCase())).map(row => row.tokenAddress.toLowerCase()),
    ...input.valuations.map(row => row.tokenAddress.toLowerCase()), ...(input.openingBalances ?? []).map(row => row.tokenAddress.toLowerCase()), ...(input.baselines ?? []).map(row => row.tokenAddress.toLowerCase()),
    ...(input.period ? [...closedIdentities.keys()] : [])])].sort();
  const positions: JournalLedgerPosition[] = [], periodPositions: JournalLedgerPeriodPosition[] = [], timeline: JournalLedgerTimelineEntry[] = [], closingLots: NonNullable<JournalLedgerResult['closingLots']> = [];
  for (const token of tokens) {
    const reasons = rejected.get(token) || new Set<string>(), lots = new Map(wallets.map(wallet => [wallet, [] as Lot[]]));
    let invested = zero, sold = zero, incoming = zero, outgoing = zero, fees = zero, acquisitionFees = zero, realized = zero;
    let nextLotOrder = 0;
    let runningQuantity = zero, runningBasis = zero, unknownLots = 0;
    let investedKnown = true, soldKnown = true, incomingKnown = true, outgoingKnown = true, fifoKnown = true, quantitiesKnown = true, feesComplete = true;
    let baselineAllocationUnknown = false, missingAcquisitionHistory = false;
    let periodRealized = zero, valuedSells = 0, excludedSells = 0, valuedOuts = 0, excludedOuts = 0, periodOrderKnown = true;
    const periodReasons = new Set<string>(rejected.get(token));
    const closedContribution = closedContributions.get(token);
    if (closedRejected.has(token)) periodReasons.add('historical_fee_allocation_unknown');
    if (closedContribution) { periodRealized = closedContribution.profit; valuedSells = closedContribution.sells; valuedOuts = closedContribution.outs; }
    const inPeriod = (event: JournalLedgerEvent) => Boolean(input.period && Date.parse(event.timestamp) >= periodFrom && Date.parse(event.timestamp) <= periodTo);
    const recordPeriod = (event: Event, change: Decimal | null, unknownReason: string, kind: 'sell' | 'transfer_out' | 'internal_fee') => {
      if (!inPeriod(event)) return;
      if (!periodOrderKnown) { change = null; periodReasons.add('execution_order_unknown'); }
      if (change === null) periodReasons.add(unknownReason); else periodRealized = periodRealized.add(change);
      if (kind === 'sell') { if (change === null) excludedSells++; else valuedSells++; }
      if (kind === 'transfer_out') { if (change === null) excludedOuts++; else valuedOuts++; }
    };
    const rows: Event[] = [];
    for (const event of events.filter(event => event.tokenAddress === token)) {
      const quantity = nonnegative(event.tokenAmount), amount = nonnegative(event.amountUsd);
      if (!positive(quantity) || !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) > Date.parse(input.asOf)) { reasons.add('invalid_event'); quantitiesKnown = false; continue; }
      const feeKey = `${event.walletAddress}:${event.feeId || event.txHash}`, evidence = feeEvidence.get(feeKey);
      let fee: Decimal | null = zero;
      if (!feesCharged.has(feeKey)) {
        feesCharged.add(feeKey); fee = evidence?.value ?? null;
      }
      rows.push({ ...event, quantity, amount, fee });
    }
    const tokenWallets = new Set(rows.map(row => row.walletAddress));
    for (const wallet of wallets) {
      const coverage = input.coverage.find(row => row.walletAddress.toLowerCase() === wallet && row.tokenAddress.toLowerCase() === token);
      // A wallet with a proved zero balance and no movements still needs coverage;
      // absence of a provider row is not proof of an empty position.
      if (!coverage?.complete) { reasons.add(coverage?.reason || 'history_incomplete'); periodReasons.add(coverage?.reason || 'history_incomplete'); }
    }
    const sameSecond = new Map<string, Event[]>();
    for (const row of rows) { const key = `${row.walletAddress}:${row.timestamp}`, grouped = sameSecond.get(key) || []; grouped.push(row); sameSecond.set(key, grouped); }
    const ambiguousOrder = new Set<string>();
    for (const group of sameSecond.values()) {
      const disposes = group.some(row => row.kind === 'sell' || row.kind === 'transfer_out');
      for (let index = 1; index < group.length; index++) {
        const left = group[index - 1], right = group[index];
        if (hasExecutionOrder(left, right)) continue;
        const leftCost = left.amount?.add(left.fee || zero), rightCost = right.amount?.add(right.fee || zero);
        // Unknown-order acquisitions are interchangeable only when their full
        // unit costs match. Otherwise a later partial disposal has no proved FIFO.
        const interchangeable = !disposes && leftCost && rightCost && leftCost.mul(right.quantity).cmp(rightCost.mul(left.quantity)) === 0;
        if (!interchangeable) { ambiguousOrder.add(right.timestamp); break; }
      }
    }
    const paired = new Set<string>();
    const acquisitionTimes = new Map(wallets.map(wallet => [wallet, new Map<string, Set<Lot>>() ]));
    const addLot = (wallet: string, lot: Lot) => {
      if (lot.acquisition) {
        const times = acquisitionTimes.get(wallet)!, sameTime = times.get(lot.acquisition.timestamp) || new Set<Lot>();
        for (const existing of sameTime) if (existing.acquisition && !hasExecutionOrder(existing.acquisition, lot.acquisition)
          && existing.cost && lot.cost && existing.cost.mul(lot.quantity).cmp(lot.cost.mul(existing.quantity)) !== 0) {
          reasons.add('execution_order_unknown'); fifoKnown = false; periodOrderKnown = false;
        }
        sameTime.add(lot); times.set(lot.acquisition.timestamp, sameTime);
      }
      lots.get(wallet)!.push(lot); runningQuantity = runningQuantity.add(lot.quantity);
      if (lot.cost) runningBasis = runningBasis.add(lot.cost); else unknownLots++;
    };
    // Historical baselines are cumulative checkpoints, not synthetic buys. They
    // retain realized profit and acquisition capital even with a zero balance.
    for (const baseline of input.baselines ?? []) {
      const wallet = baseline.walletAddress.toLowerCase();
      if (baseline.tokenAddress.toLowerCase() !== token || !selected.has(wallet)) continue;
      const seed = (value: string | null, unknown: () => void, signed = false) => {
        const parsed = signed ? Decimal.parse(value) : nonnegative(value);
        if (!parsed) { unknown(); return zero; } return parsed;
      };
      invested = invested.add(seed(baseline.investedUsd, () => { investedKnown = false; reasons.add('purchase_cost_unknown'); }));
      sold = sold.add(seed(baseline.soldUsd, () => { soldKnown = false; reasons.add('sale_value_unknown'); }));
      incoming = incoming.add(seed(baseline.incomingTransferCostUsd, () => { incomingKnown = false; reasons.add('incoming_transfer_cost_unknown'); }));
      outgoing = outgoing.add(seed(baseline.transferOutIncomeUsd, () => { outgoingKnown = false; reasons.add('outgoing_transfer_value_unknown'); }));
      realized = realized.add(seed(baseline.realizedProfitUsd, () => { fifoKnown = false; baselineAllocationUnknown = true; reasons.add('realized_cost_unknown'); }, true));
      fees = fees.add(seed(baseline.feesUsd, () => { feesComplete = false; reasons.add('fees_incomplete'); }));
      const capital = nonnegative(baseline.feeInclusiveCapitalUsd), bought = nonnegative(baseline.investedUsd), transferred = nonnegative(baseline.incomingTransferCostUsd);
      if (capital && bought && transferred && capital.cmp(bought.add(transferred)) >= 0) acquisitionFees = acquisitionFees.add(capital.sub(bought).sub(transferred));
      else { investedKnown = false; reasons.add('capital_unknown'); }
      for (const lot of baseline.lots) {
        const quantity = nonnegative(lot.tokenAmount), cost = nonnegative(lot.costBasisUsd);
        if (!positive(quantity)) { quantitiesKnown = false; reasons.add('baseline_quantity_invalid'); continue; }
        if (!cost) baselineAllocationUnknown = true;
        addLot(wallet, { quantity, cost, acquiredOrder: nextLotOrder++, acquisition: null, feeKnown: nonnegative(baseline.feesUsd) !== null });
      }
      tokenWallets.add(wallet);
    }
    for (const opening of input.openingBalances ?? []) {
      if (opening.tokenAddress.toLowerCase() !== token || !selected.has(opening.walletAddress.toLowerCase())) continue;
      const quantity = nonnegative(opening.tokenAmount);
      if (!quantity) { quantitiesKnown = false; reasons.add('opening_balance_unavailable'); continue; }
      if (positive(quantity)) {
        addLot(opening.walletAddress.toLowerCase(), { quantity, cost: null, acquiredOrder: nextLotOrder++, acquisition: null, feeKnown: false });
        tokenWallets.add(opening.walletAddress.toLowerCase());
        // The portfolio deliberately starts at registration. Never request old
        // purchases or turn these pre-existing holdings into zero-cost profit.
        reasons.add('opening_cost_unknown'); incomingKnown = false;
      }
    }
    const rowKey = (event: Event) => `${event.walletAddress}:${event.id}`;
    const consume = (wallet: string, quantity: Decimal): { parts: Lot[]; cost: Decimal | null } => {
      const queue = lots.get(wallet)!, parts: Lot[] = [];
      let remaining = quantity, cost: Decimal | null = zero;
      while (positive(remaining) && queue.length) {
        const lot = queue[0], used = lot.quantity.cmp(remaining) <= 0 ? lot.quantity : remaining;
        const usedCost = lot.cost?.mul(used).div(lot.quantity) ?? null;
        parts.push({ quantity: used, cost: usedCost, acquiredOrder: lot.acquiredOrder, acquisition: lot.acquisition, feeKnown: lot.feeKnown });
        runningQuantity = runningQuantity.sub(used); if (usedCost) runningBasis = runningBasis.sub(usedCost);
        if (cost && usedCost) cost = cost.add(usedCost); else cost = null;
        lot.quantity = lot.quantity.sub(used); lot.cost = lot.cost && usedCost ? lot.cost.sub(usedCost) : null;
        remaining = remaining.sub(used); if (!positive(lot.quantity)) {
          if (lot.cost == null) unknownLots--;
          if (lot.acquisition) {
            const times = acquisitionTimes.get(wallet)!, sameTime = times.get(lot.acquisition.timestamp);
            sameTime?.delete(lot); if (!sameTime?.size) times.delete(lot.acquisition.timestamp);
          }
          queue.shift();
        }
      }
      if (positive(remaining)) { parts.push({ quantity: remaining, cost: null, acquiredOrder: nextLotOrder++, acquisition: null, feeKnown: false }); cost = null;
        missingAcquisitionHistory = true; reasons.add('purchase_cost_unknown'); fifoKnown = false; }
      return { parts, cost };
    };
    const transferGroups = new Map<string, Event[]>();
    const transferGroup = (event: Event) => `${event.txHash}:${event.quantity.n}/${event.quantity.d}`;
    for (const event of rows) if (event.kind.startsWith('transfer_')) {
      const key = transferGroup(event), group = transferGroups.get(key) || []; group.push(event); transferGroups.set(key, group);
    }
    const strongIdentity = (event: Event, other: Event) => Boolean(event.transferId && event.transferId === other.transferId
      && event.blockNumber != null && event.blockNumber === other.blockNumber && event.logIndex != null && event.logIndex >= 0 && event.logIndex === other.logIndex);
    const candidates = new Map<string, Event[]>(), ambiguousTransfers = new Set<string>();
    for (const event of rows.filter(row => row.kind.startsWith('transfer_'))) {
      const eligible: Event[] = []; let unproven = false;
      for (const other of transferGroups.get(transferGroup(event)) || []) {
        if (other.kind === event.kind || other.walletAddress === event.walletAddress) continue;
        // A shared identifier can never override contradictory known addresses.
        if (event.counterparty && event.counterparty !== other.walletAddress || other.counterparty && other.counterparty !== event.walletAddress) {
          if (strongIdentity(event, other)) ambiguousTransfers.add(rowKey(event));
          continue;
        }
        if (event.logIndex != null && other.logIndex != null && event.logIndex !== other.logIndex) continue;
        if (strongIdentity(event, other) || event.counterparty === other.walletAddress && other.counterparty === event.walletAddress) eligible.push(other);
        else unproven = true;
      }
      candidates.set(rowKey(event), eligible);
      if (eligible.length > 1 || eligible.length === 0 && unproven) ambiguousTransfers.add(rowKey(event));
    }
    const transferPartners = new Map<string, Event>();
    for (const event of rows.filter(row => row.kind.startsWith('transfer_'))) {
      const matches = candidates.get(rowKey(event)) || [], partner = matches.length === 1 ? matches[0] : null;
      const reciprocal = partner ? candidates.get(rowKey(partner)) || [] : [];
      if (partner && reciprocal.length === 1 && reciprocal[0] === event) transferPartners.set(rowKey(event), partner);
      else if (matches.length) ambiguousTransfers.add(rowKey(event));
    }
    const internalPartner = (event: Event) => transferPartners.get(rowKey(event));
    // Internal transfers are processed with their paired outgoing movement. This
    // preserves FIFO lots even when provider rows list the recipient first.
    const internalIncoming = new Set(rows.filter(event => event.kind === 'transfer_in' && internalPartner(event)).map(rowKey));
    let timelineStart = 0;
    const captureTimeline = (index: number) => {
      if (!input.timeline || rows[index + 1]?.timestamp === rows[index].timestamp) return;
      const cashKnown = investedKnown && soldKnown && incomingKnown && outgoingKnown;
      timeline.push({ tokenAddress: token, timestamp: rows[index].timestamp, eventIds: rows.slice(timelineStart, index + 1).map(row => row.id), snapshot: {
        remainingTokenAmount: quantitiesKnown ? runningQuantity.text() : null,
        remainingCostBasisUsd: fifoKnown && unknownLots === 0 ? runningBasis.text() : null,
        realizedProfitUsd: fifoKnown && cashKnown ? realized.text() : null,
        investedUsd: investedKnown ? invested.text() : null, soldUsd: soldKnown ? sold.text() : null,
        incomingTransferCostUsd: incomingKnown ? incoming.text() : null, transferOutIncomeUsd: outgoingKnown ? outgoing.text() : null,
        feesUsd: fees.text(), feeInclusiveCapitalUsd: investedKnown && incomingKnown ? invested.add(incoming).add(acquisitionFees).text() : null,
        complete: reasons.size === 0 && cashKnown && fifoKnown && quantitiesKnown && feesComplete, reasons: [...reasons].sort(),
      } }); timelineStart = index + 1;
    };
    for (let eventIndex = 0; eventIndex < rows.length; eventIndex++) {
      const event = rows[eventIndex];
      // An unknown order can affect the surviving FIFO lots, but cannot alter
      // a later independent cycle once a whole timestamp group has genuinely
      // exhausted every reconstructed holding. Never reset inside an atomic
      // group, after a quantity contradiction, or erase a period's exclusions.
      if (eventIndex > 0 && rows[eventIndex - 1].timestamp !== event.timestamp && quantitiesKnown
        && !missingAcquisitionHistory && runningQuantity.cmp(zero) === 0) periodOrderKnown = true;
      if (event.fee) fees = fees.add(event.fee); else { feesComplete = false; reasons.add('fees_incomplete'); }
      if (ambiguousOrder.has(event.timestamp)) { reasons.add('execution_order_unknown'); fifoKnown = false; periodOrderKnown = false; }
      const key = rowKey(event);
      if (ambiguousTransfers.has(key)) { reasons.add('internal_transfer_unreconciled'); fifoKnown = false; periodReasons.add('internal_transfer_unreconciled'); }
      if (paired.has(key) || internalIncoming.has(key)) { captureTimeline(eventIndex); continue; }
      if (event.kind === 'buy') {
        if (event.amount) invested = invested.add(event.amount); else { investedKnown = false; reasons.add('purchase_cost_unknown'); }
        acquisitionFees = acquisitionFees.add(event.fee || zero);
        addLot(event.walletAddress, { quantity: event.quantity, cost: event.amount?.add(event.fee || zero) ?? null, acquiredOrder: nextLotOrder++, acquisition: event, feeKnown: event.fee !== null });
      } else if (event.kind === 'transfer_in') {
        if (event.counterparty && selected.has(event.counterparty)) { reasons.add('internal_transfer_unreconciled'); fifoKnown = false; }
        if (event.amount) incoming = incoming.add(event.amount); else { incomingKnown = false; reasons.add('incoming_transfer_cost_unknown'); }
        acquisitionFees = acquisitionFees.add(event.fee || zero);
        addLot(event.walletAddress, { quantity: event.quantity, cost: event.amount?.add(event.fee || zero) ?? null, acquiredOrder: nextLotOrder++, acquisition: event, feeKnown: event.fee !== null });
      } else if (event.kind === 'transfer_out') {
        const partner = internalPartner(event), disposition = consume(event.walletAddress, event.quantity);
        if (partner) {
          paired.add(key); paired.add(rowKey(partner)); tokenWallets.add(partner.walletAddress);
          const destination = lots.get(partner.walletAddress)!;
          for (const part of disposition.parts) addLot(partner.walletAddress, part);
          destination.sort((left, right) => left.acquiredOrder - right.acquiredOrder);
          realized = realized.sub(event.fee || zero).sub(partner.fee || zero);
          recordPeriod(event, event.fee !== null && partner.fee !== null ? zero.sub(event.fee).sub(partner.fee) : null, 'fees_incomplete', 'internal_fee');
        } else {
          if (event.counterparty && selected.has(event.counterparty)) { reasons.add('internal_transfer_unreconciled'); fifoKnown = false; }
          if (event.amount) outgoing = outgoing.add(event.amount); else { outgoingKnown = false; reasons.add('outgoing_transfer_value_unknown'); }
          const disposalProfit = event.amount && disposition.cost ? event.amount.sub(disposition.cost).sub(event.fee || zero) : null;
          if (disposalProfit) realized = realized.add(disposalProfit); else fifoKnown = false;
          const costKnown = disposition.cost !== null && disposition.parts.every(part => part.feeKnown);
          recordPeriod(event, costKnown && event.fee !== null ? disposalProfit : null,
            event.amount === null ? 'outgoing_transfer_value_unknown' : disposition.cost === null ? 'purchase_cost_unknown' : 'fees_incomplete', 'transfer_out');
        }
      } else {
        const disposition = consume(event.walletAddress, event.quantity);
        if (event.amount) sold = sold.add(event.amount); else { soldKnown = false; reasons.add('sale_value_unknown'); }
        const disposalProfit = event.amount && disposition.cost ? event.amount.sub(disposition.cost).sub(event.fee || zero) : null;
        if (disposalProfit) realized = realized.add(disposalProfit); else fifoKnown = false;
        const costKnown = disposition.cost !== null && disposition.parts.every(part => part.feeKnown);
        recordPeriod(event, costKnown && event.fee !== null ? disposalProfit : null,
          event.amount === null ? 'sale_value_unknown' : disposition.cost === null ? 'purchase_cost_unknown' : 'fees_incomplete', 'sell');
      }
      captureTimeline(eventIndex);
    }
    const remaining = runningQuantity;
    let cost: Decimal | null = unknownLots === 0 ? runningBasis : null;
    if (!fifoKnown) cost = null;
    const valuation = input.valuations.find(row => row.tokenAddress.toLowerCase() === token), price = nonnegative(valuation?.priceUsd);
    for (const wallet of wallets) {
      // Partial collection/decoding cannot contradict holdings it has not yet
      // reconstructed. Coverage remains incomplete and eligibility stays false.
      const coverage = input.coverage.find(row => row.walletAddress.toLowerCase() === wallet && row.tokenAddress.toLowerCase() === token);
      if (!coverage?.complete && !coverage?.quantitiesComplete) continue;
      const balance = valuation?.balances.find(row => row.walletAddress.toLowerCase() === wallet), actual = nonnegative(balance?.tokenAmount), tolerance = nonnegative(balance?.tolerance || '0')!;
      const expected = lots.get(wallet)!.reduce((value, lot) => value.add(lot.quantity), zero);
      if (!actual || expected.sub(actual).abs().cmp(tolerance) > 0) reasons.add('balance_unreconciled');
    }
    const value = quantitiesKnown && (!positive(remaining) || price) ? remaining.mul(price || zero) : null;
    if (!value) reasons.add('quote_unavailable');
    if (cost == null) reasons.add('purchase_cost_unknown');
    const cashKnown = investedKnown && soldKnown && incomingKnown && outgoingKnown;
    const capital = investedKnown && incomingKnown ? invested.add(incoming).add(acquisitionFees) : null;
    if (input.period) {
      if (!quantitiesKnown) periodReasons.add('quantities_unavailable');
      if (valuation && reasons.has('balance_unreconciled')) periodReasons.add('balance_unreconciled');
      // An observed purchase does not establish FIFO if older holdings or
      // movements are missing. Preserve other independently covered positions,
      // but never label this position's possibly displaced lots a known gain.
      const quantityCoverageComplete = wallets.every(wallet => input.coverage.some(row => row.walletAddress.toLowerCase() === wallet
        && row.tokenAddress.toLowerCase() === token && row.complete));
      if (!quantityCoverageComplete || !quantitiesKnown || (rejected.get(token)?.size ?? 0) > 0 || valuation && reasons.has('balance_unreconciled')) {
        periodRealized = zero;
        excludedSells += valuedSells; valuedSells = 0;
        excludedOuts += valuedOuts; valuedOuts = 0;
      }
      const complete = periodReasons.size === 0;
      periodPositions.push({ tokenAddress: token, realizedProfitUsd: complete ? periodRealized.text() : null,
        knownRealizedProfitUsd: periodRealized.text(), closedBaselineFeesUsd: closedContribution?.fees.text() ?? '0', valuedSellCount: valuedSells, excludedSellCount: excludedSells,
        valuedTransferOutCount: valuedOuts, excludedTransferOutCount: excludedOuts, complete, reasons: [...periodReasons].sort() });
    }
    // A reconciled baseline may prove every cash flow and complete fees without
    // allocating aggregate acquisition fees to individual surviving FIFO lots.
    // That allocation is unnecessary for total profit, but remains unknown for
    // realized/unrealized splits and historical prefix frames. Missing actual
    // acquisitions or any other coverage/quantity/cost error never qualifies.
    const cashFlowEnding = baselineAllocationUnknown && !missingAcquisitionHistory && cashKnown && quantitiesKnown && feesComplete
      && [...reasons].every(reason => reason === 'realized_cost_unknown' || reason === 'purchase_cost_unknown');
    const accountingComplete = cashKnown && quantitiesKnown && feesComplete && (reasons.size === 0 && fifoKnown || cashFlowEnding);
    const profit = value && cashKnown ? sold.add(outgoing).add(value).sub(invested).sub(incoming).sub(fees) : null;
    if (cashFlowEnding) { reasons.delete('realized_cost_unknown'); reasons.delete('purchase_cost_unknown'); reasons.add('fifo_allocation_unknown'); }
    positions.push({ tokenAddress: token, wallets: [...tokenWallets].sort(), state: quantitiesKnown ? positive(remaining) ? 'open' : 'closed' : 'unknown',
      remainingTokenAmount: quantitiesKnown ? remaining.text() : null, remainingCostBasisUsd: cost?.text() ?? null,
      valueUsd: value?.text() ?? null, investedUsd: investedKnown ? invested.text() : null, soldUsd: soldKnown ? sold.text() : null,
      incomingTransferCostUsd: incomingKnown ? incoming.text() : null, transferOutIncomeUsd: outgoingKnown ? outgoing.text() : null,
      realizedProfitUsd: accountingComplete && !positive(remaining) ? profit?.text() ?? null : fifoKnown && cashKnown ? realized.text() : null,
      unrealizedProfitUsd: value && cost ? value.sub(cost).text() : null,
      estimatedProfitUsd: accountingComplete ? profit?.text() ?? null : null,
      roi: accountingComplete && profit && capital && positive(capital) ? profit.div(capital).text() : null,
      feeInclusiveCapitalUsd: capital?.text() ?? null, feesUsd: fees.text(), pricedAt: valuation?.pricedAt ?? null,
      complete: accountingComplete, estimated: !feesComplete || cashFlowEnding, reasons: [...reasons].sort() });
    for (const [walletAddress, queue] of lots) closingLots.push({ walletAddress, tokenAddress: token,
      lots: queue.map(lot => ({ tokenAmount: lot.quantity.text(), costBasisUsd: lot.cost?.text() ?? null })) });
  }
  const complete = positions.every(position => position.complete), reasons = [...new Set(positions.flatMap(position => position.reasons))].sort();
  const sum = (field: 'valueUsd' | 'investedUsd' | 'soldUsd' | 'realizedProfitUsd' | 'estimatedProfitUsd' | 'feeInclusiveCapitalUsd' | 'feesUsd') => {
    let result = zero; for (const position of positions) { const value = Decimal.parse(position[field]); if (!value) return null; result = result.add(value); } return result;
  };
  const profit = complete ? sum('estimatedProfitUsd') : null, capital = complete ? sum('feeInclusiveCapitalUsd') : null;
  const periodReasonSet = new Set(periodPositions.flatMap(position => position.reasons));
  let periodFeeOnly = zero, valuedFees = 0, excludedFees = 0;
  const movementFees = new Map(events.map(event => [`${event.walletAddress}:${event.feeId || event.txHash}`, event]));
  for (const contribution of closedContributions.values()) for (const event of contribution.events)
    movementFees.set(`${event.walletAddress.toLowerCase()}:${event.feeId || event.txHash.toLowerCase()}`, event);
  const periodFeeEvidence = new Map<string, JournalLedgerPeriodFeeEvent>();
  const closedFeeConflicts = new Set<string>();
  if (input.period) for (const event of input.periodFeeEvents ?? []) {
    const wallet = event.walletAddress.toLowerCase(), timestamp = Date.parse(event.timestamp);
    if (!selected.has(wallet)) continue;
    if (!Number.isFinite(timestamp)) { periodReasonSet.add('invalid_fee_event'); excludedFees++; continue; }
    if (timestamp < periodFrom || timestamp > periodTo) continue;
    const key = `${wallet}:${event.feeId || event.txHash.toLowerCase()}`, existing = periodFeeEvidence.get(key);
    if (existing) {
      const before = nonnegative(existing.feeUsd), next = nonnegative(event.feeUsd);
      if (Boolean(before) !== Boolean(next) || before && next && before.cmp(next) !== 0 || Date.parse(existing.timestamp) !== timestamp
        || existing.txHash.toLowerCase() !== event.txHash.toLowerCase()) periodReasonSet.add('contradictory_fee');
      continue;
    }
    periodFeeEvidence.set(key, event);
    const covered = [...closedContributions.values()].map(contribution => ({ contribution, matches: contribution.events.filter(row =>
      row.walletAddress.toLowerCase() === wallet && (`${wallet}:${row.feeId || row.txHash.toLowerCase()}` === key
        || event.transactionScoped === true && row.txHash.toLowerCase() === event.txHash.toLowerCase())) })).filter(row => row.matches.length > 0);
    if (covered.length) {
      if (covered.length !== 1) covered.forEach(row => closedFeeConflicts.add(row.contribution.token));
      else {
        const { contribution, matches } = covered[0], keys = new Set(matches.map(row => `${wallet}:${row.feeId || row.txHash.toLowerCase()}`));
        if (keys.size !== 1) closedFeeConflicts.add(contribution.token);
        else {
          const historicalKey = [...keys][0], supplied = nonnegative(event.feeUsd), historical = contribution.knownFees.get(historicalKey);
          if (supplied && historical && !closedMoneyMatches(supplied, historical)) closedFeeConflicts.add(contribution.token);
          else if (supplied) contribution.knownFees.set(historicalKey, supplied);
        }
      }
      continue;
    }
    const movement = movementFees.get(key);
    if (movement) {
      const existingFee = feeEvidence.get(key)?.value, suppliedFee = nonnegative(event.feeUsd);
      if (existingFee && suppliedFee && existingFee.cmp(suppliedFee) !== 0 || Date.parse(movement.timestamp) !== timestamp
        || movement.txHash !== event.txHash.toLowerCase()) periodReasonSet.add('contradictory_fee');
      continue;
    }
    const fee = nonnegative(event.feeUsd);
    if (fee === null) { periodReasonSet.add('fees_incomplete'); excludedFees++; }
    else { periodFeeOnly = periodFeeOnly.add(fee); valuedFees++; }
  }
  for (const contribution of closedContributions.values()) if ([...contribution.knownFees.values()].reduce((sum, fee) => sum.add(fee), zero).cmp(contribution.fees) > 0)
    closedFeeConflicts.add(contribution.token);
  for (const token of closedFeeConflicts) {
    const position = periodPositions.find(row => row.tokenAddress === token);
    if (!position) continue;
    position.complete = false; position.realizedProfitUsd = null; position.knownRealizedProfitUsd = '0';
    position.excludedSellCount += position.valuedSellCount; position.valuedSellCount = 0;
    position.excludedTransferOutCount += position.valuedTransferOutCount; position.valuedTransferOutCount = 0;
    position.reasons = [...new Set([...position.reasons, 'contradictory_fee'])].sort(); periodReasonSet.add('contradictory_fee');
  }
  const periodReasons = [...periodReasonSet].sort(), periodComplete = periodPositions.every(position => position.complete) && periodReasons.length === 0;
  const periodKnown = Decimal.parse(sumJournalDecimals(periodPositions.map(position => position.knownRealizedProfitUsd)))!.sub(periodFeeOnly).text();
  const period = input.period ? { wallets, from: new Date(periodFrom).toISOString(), to: new Date(periodTo).toISOString(), positions: periodPositions,
    complete: periodComplete, reasons: periodReasons, totals: { realizedProfitUsd: periodComplete ? periodKnown : null, knownRealizedProfitUsd: periodKnown,
      closedBaselineFeesUsd: sumJournalDecimals(periodPositions.map(position => position.closedBaselineFeesUsd)),
      valuedSellCount: periodPositions.reduce((sum, row) => sum + row.valuedSellCount, 0), excludedSellCount: periodPositions.reduce((sum, row) => sum + row.excludedSellCount, 0),
      valuedTransferOutCount: periodPositions.reduce((sum, row) => sum + row.valuedTransferOutCount, 0), excludedTransferOutCount: periodPositions.reduce((sum, row) => sum + row.excludedTransferOutCount, 0),
      feeOnlyFeesUsd: excludedFees ? null : periodFeeOnly.text(), valuedFeeCount: valuedFees, excludedFeeCount: excludedFees,
      complete: periodComplete, reasons: periodReasons } } : undefined;
  return { wallets, asOf: input.asOf, positions, complete, reasons, closingLots, ...(input.timeline ? { timeline } : {}), ...(period ? { period } : {}), totals: {
    valueUsd: sum('valueUsd')?.text() ?? null, investedUsd: sum('investedUsd')?.text() ?? null, soldUsd: sum('soldUsd')?.text() ?? null,
    realizedProfitUsd: complete ? sum('realizedProfitUsd')?.text() ?? null : null,
    estimatedProfitUsd: profit?.text() ?? null, roi: profit && capital && positive(capital) ? profit.div(capital).text() : null,
    feeInclusiveCapitalUsd: capital?.text() ?? null, feesUsd: sum('feesUsd')?.text() || '0' } };
}

/** This adapter runs the shared lifetime FIFO once; it never differences opaque
 * lifetime aggregates or applies a current market quote to realized gains. */
export function calculateJournalLedgerPeriod(input: Omit<JournalLedgerInput, 'valuations' | 'timeline' | 'period'> & {
  valuations?: JournalLedgerValuation[]; period: { from: string; to: string };
}): JournalLedgerPeriodResult {
  return calculateJournalLedger({ ...input, valuations: input.valuations ?? [], timeline: false }).period!;
}
