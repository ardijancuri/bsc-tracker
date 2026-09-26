export const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const swapTopics = new Set([
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
]);
// The Flap/GMGN router emits the actual BNB paid to the recipient in its Swap event.
const flapRouter = '0x1de460f363af910f51726def188f9004276bf4bc';
const flapSwapTopic = '0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a';
const botRouter = '0x9689992f5b5c09447f15906d8d11214944488341';
const wrappedBnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const withdrawalTopic = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

export type TransferLog = { address: string; topics: string[]; data: string };
const addressFromTopic = (topic: string | undefined) => topic?.length === 66 ? `0x${topic.slice(-40).toLowerCase()}` : null;
export const hasRecognizedSwap = (logs: TransferLog[]) => logs.some(log => swapTopics.has(log.topics[0]?.toLowerCase()) ||
  (log.address.toLowerCase() === flapRouter && log.topics[0]?.toLowerCase() === flapSwapTopic));

export function nativeSellProceeds(wallet: string, soldRaw: bigint, logs: TransferLog[], router?: string | null): bigint | null {
  const zero = '0x' + '0'.repeat(64);
  const recipient = wallet.toLowerCase();
  const matches = logs.filter(log =>
    log.address.toLowerCase() === flapRouter && log.topics[0]?.toLowerCase() === flapSwapTopic &&
    addressFromTopic(log.topics[1]) === recipient && addressFromTopic(log.topics[2]) === recipient &&
    log.topics[3]?.toLowerCase() === zero && /^0x[0-9a-fA-F]{128,}$/.test(log.data) &&
    BigInt(`0x${log.data.slice(2, 66)}`) === soldRaw,
  );
  if (matches.length === 1) {
    const paid = BigInt(`0x${matches[0].data.slice(66, 130)}`);
    return paid > 0n ? paid : null;
  }
  // This bot router unwraps the single WBNB output of a Pancake swap to pay native BNB.
  if (router?.toLowerCase() !== botRouter || !logs.some(log => swapTopics.has(log.topics[0]?.toLowerCase()))) return null;
  const withdrawals = logs.filter(log => log.address.toLowerCase() === wrappedBnb &&
    log.topics[0]?.toLowerCase() === withdrawalTopic && addressFromTopic(log.topics[1]) === botRouter &&
    /^0x[0-9a-fA-F]{64}$/.test(log.data));
  if (withdrawals.length !== 1) return null;
  const output = BigInt(withdrawals[0].data);
  return output > 0n ? output : null;
}

export function walletSwapFlows(wallet: string, value: bigint, logs: TransferLog[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== transferTopic || log.topics.length < 3 || !/^0x[a-fA-F0-9]{40}$/.test(log.address)) continue;
    const from = addressFromTopic(log.topics[1]);
    const to = addressFromTopic(log.topics[2]);
    if (!from || !to || from === to) continue;
    const raw = BigInt(log.data);
    const token = log.address.toLowerCase();
    if (from === wallet) net.set(token, (net.get(token) || 0n) - raw);
    if (to === wallet) net.set(token, (net.get(token) || 0n) + raw);
  }
  for (const [token, amount] of net) if (amount === 0n) net.delete(token);
  const amounts = [...net.values()];
  const hasSwap = hasRecognizedSwap(logs);
  const hasIn = amounts.some(amount => amount > 0n);
  const hasOut = amounts.some(amount => amount < 0n);
  if (!hasSwap && !(hasIn && hasOut) && !(value > 0n && hasIn)) net.clear();
  return net;
}
