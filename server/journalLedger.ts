/** Exact-decimal accounting for a private set of wallets. No provider totals or
 * percentages are added together here: the selected wallets form one ledger. */
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
export interface JournalLedgerCoverage { walletAddress: string; tokenAddress: string; complete: boolean; reason?: string }
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
export function journalDecimalMultiply(left: string, right: string): string | null {
  const a = Decimal.parse(left), b = Decimal.parse(right); return a && b ? a.mul(b).text() : null;
}
export function journalDecimalDivide(left: string, right: string): string | null {
  const a = Decimal.parse(left), b = Decimal.parse(right); return a && b && b.cmp(zero) !== 0 ? a.div(b).text() : null;
}
type Lot = { quantity: Decimal; cost: Decimal | null; acquiredOrder: number; acquisition: JournalLedgerEvent | null };
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

export function calculateJournalLedger(input: {
  wallets: string[]; events: JournalLedgerEvent[]; valuations: JournalLedgerValuation[];
  coverage: JournalLedgerCoverage[]; asOf: string; timeline?: boolean;
}): JournalLedgerResult {
  const wallets = [...new Set(input.wallets.map(wallet => wallet.toLowerCase()))].sort(), selected = new Set(wallets);
  const rejected = new Map<string, Set<string>>(), unique = new Map<string, JournalLedgerEvent>();
  const reject = (token: string, reason: string) => { const reasons = rejected.get(token) || new Set<string>(); reasons.add(reason); rejected.set(token, reasons); };
  for (const row of input.events) {
    const walletAddress = row.walletAddress.toLowerCase(), tokenAddress = row.tokenAddress.toLowerCase();
    if (!selected.has(walletAddress)) continue;
    const event = { ...row, walletAddress, tokenAddress, txHash: row.txHash.toLowerCase(), counterparty: row.counterparty?.toLowerCase() };
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
    ...input.valuations.map(row => row.tokenAddress.toLowerCase())])].sort();
  const positions: JournalLedgerPosition[] = [], timeline: JournalLedgerTimelineEntry[] = [];
  for (const token of tokens) {
    const reasons = rejected.get(token) || new Set<string>(), lots = new Map(wallets.map(wallet => [wallet, [] as Lot[]]));
    let invested = zero, sold = zero, incoming = zero, outgoing = zero, fees = zero, acquisitionFees = zero, realized = zero;
    let nextLotOrder = 0;
    let runningQuantity = zero, runningBasis = zero, unknownLots = 0;
    let investedKnown = true, soldKnown = true, incomingKnown = true, outgoingKnown = true, fifoKnown = true, quantitiesKnown = true, feesComplete = true;
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
      if (!coverage?.complete) reasons.add(coverage?.reason || 'history_incomplete');
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
          reasons.add('execution_order_unknown'); fifoKnown = false;
        }
        sameTime.add(lot); times.set(lot.acquisition.timestamp, sameTime);
      }
      lots.get(wallet)!.push(lot); runningQuantity = runningQuantity.add(lot.quantity);
      if (lot.cost) runningBasis = runningBasis.add(lot.cost); else unknownLots++;
    };
    const rowKey = (event: Event) => `${event.walletAddress}:${event.id}`;
    const consume = (wallet: string, quantity: Decimal): { parts: Lot[]; cost: Decimal | null } => {
      const queue = lots.get(wallet)!, parts: Lot[] = [];
      let remaining = quantity, cost: Decimal | null = zero;
      while (positive(remaining) && queue.length) {
        const lot = queue[0], used = lot.quantity.cmp(remaining) <= 0 ? lot.quantity : remaining;
        const usedCost = lot.cost?.mul(used).div(lot.quantity) ?? null;
        parts.push({ quantity: used, cost: usedCost, acquiredOrder: lot.acquiredOrder, acquisition: lot.acquisition });
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
      if (positive(remaining)) { parts.push({ quantity: remaining, cost: null, acquiredOrder: nextLotOrder++, acquisition: null }); cost = null; reasons.add('purchase_cost_unknown'); fifoKnown = false; }
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
      if (event.fee) fees = fees.add(event.fee); else { feesComplete = false; reasons.add('fees_incomplete'); }
      if (ambiguousOrder.has(event.timestamp)) { reasons.add('execution_order_unknown'); fifoKnown = false; }
      const key = rowKey(event);
      if (ambiguousTransfers.has(key)) { reasons.add('internal_transfer_unreconciled'); fifoKnown = false; }
      if (paired.has(key) || internalIncoming.has(key)) { captureTimeline(eventIndex); continue; }
      if (event.kind === 'buy') {
        if (event.amount) invested = invested.add(event.amount); else { investedKnown = false; reasons.add('purchase_cost_unknown'); }
        acquisitionFees = acquisitionFees.add(event.fee || zero);
        addLot(event.walletAddress, { quantity: event.quantity, cost: event.amount?.add(event.fee || zero) ?? null, acquiredOrder: nextLotOrder++, acquisition: event });
      } else if (event.kind === 'transfer_in') {
        if (event.counterparty && selected.has(event.counterparty)) { reasons.add('internal_transfer_unreconciled'); fifoKnown = false; }
        if (event.amount) incoming = incoming.add(event.amount); else { incomingKnown = false; reasons.add('incoming_transfer_cost_unknown'); }
        acquisitionFees = acquisitionFees.add(event.fee || zero);
        addLot(event.walletAddress, { quantity: event.quantity, cost: event.amount?.add(event.fee || zero) ?? null, acquiredOrder: nextLotOrder++, acquisition: event });
      } else if (event.kind === 'transfer_out') {
        const partner = internalPartner(event), disposition = consume(event.walletAddress, event.quantity);
        if (partner) {
          paired.add(key); paired.add(rowKey(partner)); tokenWallets.add(partner.walletAddress);
          const destination = lots.get(partner.walletAddress)!;
          for (const part of disposition.parts) addLot(partner.walletAddress, part);
          destination.sort((left, right) => left.acquiredOrder - right.acquiredOrder);
          realized = realized.sub(event.fee || zero).sub(partner.fee || zero);
        } else {
          if (event.counterparty && selected.has(event.counterparty)) { reasons.add('internal_transfer_unreconciled'); fifoKnown = false; }
          if (event.amount) outgoing = outgoing.add(event.amount); else { outgoingKnown = false; reasons.add('outgoing_transfer_value_unknown'); }
          if (event.amount && disposition.cost) realized = realized.add(event.amount).sub(disposition.cost).sub(event.fee || zero); else fifoKnown = false;
        }
      } else {
        const disposition = consume(event.walletAddress, event.quantity);
        if (event.amount) sold = sold.add(event.amount); else { soldKnown = false; reasons.add('sale_value_unknown'); }
        if (event.amount && disposition.cost) realized = realized.add(event.amount).sub(disposition.cost).sub(event.fee || zero); else fifoKnown = false;
      }
      captureTimeline(eventIndex);
    }
    const remaining = runningQuantity;
    let cost: Decimal | null = unknownLots === 0 ? runningBasis : null;
    if (!fifoKnown) cost = null;
    const valuation = input.valuations.find(row => row.tokenAddress.toLowerCase() === token), price = nonnegative(valuation?.priceUsd);
    for (const wallet of wallets) {
      const balance = valuation?.balances.find(row => row.walletAddress.toLowerCase() === wallet), actual = nonnegative(balance?.tokenAmount), tolerance = nonnegative(balance?.tolerance || '0')!;
      const expected = lots.get(wallet)!.reduce((value, lot) => value.add(lot.quantity), zero);
      if (!actual || expected.sub(actual).abs().cmp(tolerance) > 0) reasons.add('balance_unreconciled');
    }
    const value = quantitiesKnown && (!positive(remaining) || price) ? remaining.mul(price || zero) : null;
    if (!value) reasons.add('quote_unavailable');
    if (cost == null) reasons.add('purchase_cost_unknown');
    const cashKnown = investedKnown && soldKnown && incomingKnown && outgoingKnown;
    const capital = investedKnown && incomingKnown ? invested.add(incoming).add(acquisitionFees) : null;
    const accountingComplete = reasons.size === 0 && cashKnown && fifoKnown && quantitiesKnown && feesComplete;
    const profit = value && cashKnown ? sold.add(outgoing).add(value).sub(invested).sub(incoming).sub(fees) : null;
    positions.push({ tokenAddress: token, wallets: [...tokenWallets].sort(), state: quantitiesKnown ? positive(remaining) ? 'open' : 'closed' : 'unknown',
      remainingTokenAmount: quantitiesKnown ? remaining.text() : null, remainingCostBasisUsd: cost?.text() ?? null,
      valueUsd: value?.text() ?? null, investedUsd: investedKnown ? invested.text() : null, soldUsd: soldKnown ? sold.text() : null,
      incomingTransferCostUsd: incomingKnown ? incoming.text() : null, transferOutIncomeUsd: outgoingKnown ? outgoing.text() : null,
      realizedProfitUsd: fifoKnown && cashKnown ? realized.text() : null,
      unrealizedProfitUsd: value && cost ? value.sub(cost).text() : null,
      estimatedProfitUsd: accountingComplete ? profit?.text() ?? null : null,
      roi: accountingComplete && profit && capital && positive(capital) ? profit.div(capital).text() : null,
      feeInclusiveCapitalUsd: capital?.text() ?? null, feesUsd: fees.text(), pricedAt: valuation?.pricedAt ?? null,
      complete: accountingComplete, estimated: !feesComplete, reasons: [...reasons].sort() });
  }
  const complete = positions.every(position => position.complete), reasons = [...new Set(positions.flatMap(position => position.reasons))].sort();
  const sum = (field: 'valueUsd' | 'investedUsd' | 'soldUsd' | 'realizedProfitUsd' | 'estimatedProfitUsd' | 'feeInclusiveCapitalUsd' | 'feesUsd') => {
    let result = zero; for (const position of positions) { const value = Decimal.parse(position[field]); if (!value) return null; result = result.add(value); } return result;
  };
  const profit = complete ? sum('estimatedProfitUsd') : null, capital = complete ? sum('feeInclusiveCapitalUsd') : null;
  return { wallets, asOf: input.asOf, positions, complete, reasons, ...(input.timeline ? { timeline } : {}), totals: {
    valueUsd: sum('valueUsd')?.text() ?? null, investedUsd: sum('investedUsd')?.text() ?? null, soldUsd: sum('soldUsd')?.text() ?? null,
    realizedProfitUsd: complete ? sum('realizedProfitUsd')?.text() ?? null : null,
    estimatedProfitUsd: profit?.text() ?? null, roi: profit && capital && positive(capital) ? profit.div(capital).text() : null,
    feeInclusiveCapitalUsd: capital?.text() ?? null, feesUsd: sum('feesUsd')?.text() || '0' } };
}
