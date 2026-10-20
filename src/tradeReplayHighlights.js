/** Presentation-only highlights. These helpers never calculate trade profit. */
const finiteNumber = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value))
  ? Number(value) : null;

const eventTime = event => Number.isFinite(event.ts) ? event.ts : Date.parse(event.timestamp);

function timestampGroups(events) {
  const sorted = events.map((event, index) => ({ event, index, ts: eventTime(event) }))
    .filter(item => Number.isFinite(item.ts)).sort((a, b) => a.ts - b.ts || a.index - b.index);
  const groups = [];
  for (const item of sorted) {
    if (groups.at(-1)?.ts !== item.ts) groups.push({ ts: item.ts, events: [] });
    groups.at(-1).events.push(item.event);
  }
  return groups;
}

function knownGroupRealized(group) {
  if (!group) return null;
  const values = group.events.map(event => finiteNumber(event.cumulativeRealizedProfitUsd));
  // A timestamp can be atomic without a known execution order. Different
  // snapshots inside it cannot establish which sale earned a positive delta.
  return values.every(value => value !== null && value === values[0]) ? values[0] : null;
}

function profitableSellIds(trades, accountingEvents) {
  const accounting = accountingEvents.length > 0;
  const groups = timestampGroups(accounting ? accountingEvents : trades);
  const profitable = new Set();
  for (let index = 1; index < groups.length; index += 1) {
    const group = groups[index], previous = knownGroupRealized(groups[index - 1]), current = knownGroupRealized(group);
    const sells = group.events.filter(event => (event.kind ?? event.side) === 'sell');
    if (previous === null || current === null || sells.length !== 1
      || group.events.some(event => event.kind === 'transfer_out')) continue;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(previous), Math.abs(current)) * 8;
    if (current - previous > tolerance) {
      const id = accounting ? sells[0].tradeId : sells[0].id;
      if (id !== undefined) profitable.add(id);
    }
  }
  return profitable;
}

/**
 * Select at most three material sells, with conservative evidence for wording.
 * Relative size chooses presentation emphasis; it never implies profitability.
 */
export function selectReplaySellHighlights(trades, accountingEvents = []) {
  if (!Array.isArray(trades) || !trades.length) return [];
  const sells = trades.map((trade, tradeIndex) => ({ trade, tradeIndex, amountUsd: finiteNumber(trade.amountUsd) }))
    .filter(item => item.trade.side === 'sell' && item.amountUsd !== null && item.amountUsd > 0);
  if (!sells.length) return [];
  const amounts = sells.map(sell => sell.amountUsd).sort((a, b) => a - b), middle = Math.floor(amounts.length / 2);
  const median = amounts.length % 2 ? amounts[middle] : (amounts[middle - 1] + amounts[middle]) / 2;
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isFinite(total)) return [];
  const profitable = profitableSellIds(trades, Array.isArray(accountingEvents) ? accountingEvents : []);
  return sells.filter(sell => sell.amountUsd >= 100
    && (sell.amountUsd / total >= .25 || sell.amountUsd >= median * 1.5))
    .sort((a, b) => b.amountUsd - a.amountUsd || a.tradeIndex - b.tradeIndex).slice(0, 3)
    .sort((a, b) => a.tradeIndex - b.tradeIndex)
    .map(sell => ({ tradeIndex: sell.tradeIndex, amountUsd: sell.amountUsd,
      label: profitable.has(sell.trade.id) ? 'Take profit' : 'Big sell' }));
}

/**
 * Allocate more of the existing event phase to the gaps around highlighted
 * groups. Duplicate knots stay atomic and the first/last knots stay fixed.
 */
export function reweightReplayProgress(baseProgresses, selectedIndices, endPhase = baseProgresses.at(-1)) {
  const result = [...baseProgresses];
  if (result.length < 2 || !result.every(Number.isFinite)
    || result.some((value, index) => index > 0 && value < result[index - 1])) return result;
  const start = result[0], end = Number.isFinite(endPhase) ? endPhase : result.at(-1);
  if (end <= start) return result;
  const boostedGaps = new Set();
  for (const index of selectedIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= result.length) continue;
    let before = index, after = index;
    while (before > 0 && result[before - 1] === result[index]) before -= 1;
    while (after < result.length - 1 && result[after + 1] === result[index]) after += 1;
    if (before > 0) boostedGaps.add(before - 1);
    if (after < result.length - 1) boostedGaps.add(after);
  }
  if (!boostedGaps.size) return result;
  const weights = result.slice(1).map((value, index) => (value - result[index]) * (boostedGaps.has(index) ? 3.1 : 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) return result;
  let progress = start;
  for (let index = 1; index < result.length; index += 1) {
    progress += (end - start) * weights[index - 1] / total;
    result[index] = progress;
  }
  // Pin the entire final atomic group, not just its last member: rounding the
  // final knot alone could separate simultaneous events by a floating epsilon.
  for (let index = result.length - 1; index >= 0 && baseProgresses[index] === baseProgresses.at(-1); index -= 1) result[index] = end;
  return result;
}
