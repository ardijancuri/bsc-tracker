export const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const swapTopics = new Set([
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
]);
// The Flap/GMGN router emits the actual BNB paid to the recipient in its Swap event.
const flapRouters = new Set(['0x1de460f363af910f51726def188f9004276bf4bc',
  '0x3508dca95a64c9378cb07ef6f40553a50905372a', '0xef312c613199ac91ee23743565e6a4e4e65fe2c0']);
const flapSwapTopic = '0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a';
const binanceDexRouter = '0xb300000b72deaeb607a12d5f54773d1c19c7028d';
const binanceDexSwapTopic = '0xf228de527fc1b9843baac03b9a04565473a263375950e63435d4138464386f46';
const botRouter = '0x9689992f5b5c09447f15906d8d11214944488341';
const wrappedBnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const withdrawalTopic = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const nativeAddresses = new Set(['0x' + '0'.repeat(40), '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0x' + '0'.repeat(36) + 'dead']);
// These events contain the recipient's net payout, after the router's fees.
const payoutFormats = [
  { routers: ['0x01a21c857a3219991fba2b1a2824b1b758966b54'], topic: '0xb4ebd56706d27fa01a1b393765021ba216f704b12bb50a87bf257d3ba6cd7bdc', words: 6, kind: 'indexedRecipient' },
  { routers: ['0x5994814f2c4040b863a0125a45de152a8c2a4dec'], topic: '0x1bb43f2da90e35f7b0cf38521ca95a49e68eb42fac49924930a5bd73cdf7576c', words: 5, kind: 'recipientWord' },
  { routers: ['0xa8db7e3141527589fbc68dca0b2d6378037d723f', '0x3746804e5a38b1df09e6975009525ea68f923401'], topic: '0x2ed5a8749a7e3a68a074750cc77850912a0708dc62ab7ea42b0c3e5beb36f017', words: 11, kind: 'indexedAssets' },
  { routers: ['0xd36b6d646ac6e23672e9eedec558164c7f2d6deb'], topic: '0x20efd6d5195b7b50273f01cd79a27989255356f9f13293edc53ee142accfdb75', words: 6, kind: 'senderAndRecipientWords' },
] as const;
const binanceOutputRouter = '0x3d90f66b534dd8482b181e24655a9e8265316be9';
const binanceOutputTopic = '0xe5b9f85c5caca875a8b78e5b2d88de86d7793cbff3d81ea4ecbec4c2b9ad7beb';

export type TransferLog = { address: string; topics: string[]; data: string };
const addressFromTopic = (topic: string | undefined) => topic?.length === 66 ? `0x${topic.slice(-40).toLowerCase()}` : null;
const wordsOf = (log: TransferLog, count: number) => new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(log.data)
  ? log.data.slice(2).match(/.{64}/g)! : null;
const wordAddress = (word: string) => /^0{24}[0-9a-fA-F]{40}$/.test(word) ? `0x${word.slice(-40).toLowerCase()}` : null;
// Tax/rebase token Transfer amounts can differ from the router input by a few raw
// units. Allow at most one part per trillion, only with an explicit asset match.
const sameQuantity = (actual: bigint, requested: bigint, assetMatched = false) => {
  const difference = actual > requested ? actual - requested : requested - actual;
  return difference === 0n || (assetMatched && difference <= actual / 1_000_000_000_000n);
};
const flapInputToken = (log: TransferLog) => {
  if (!/^0x(?:[0-9a-fA-F]{64})+$/.test(log.data)) return null;
  const words = log.data.slice(2).match(/.{64}/g)!;
  if (words.length < 7 || BigInt(`0x${words[2]}`) !== 96n || BigInt(`0x${words[3]}`) === 0n) return null;
  const offset = BigInt(`0x${words[4]}`);
  if (offset % 32n || offset / 32n > BigInt(words.length - 6)) return null;
  return wordAddress(words[5 + Number(offset / 32n)]);
};
export const hasRecognizedSwap = (logs: TransferLog[]) => logs.some(log => swapTopics.has(log.topics[0]?.toLowerCase()) ||
  (flapRouters.has(log.address.toLowerCase()) && log.topics[0]?.toLowerCase() === flapSwapTopic) ||
  payoutFormats.some(format => format.routers.some(address => address === log.address.toLowerCase()) && format.topic === log.topics[0]?.toLowerCase()) ||
  (log.address.toLowerCase() === binanceDexRouter && log.topics[0]?.toLowerCase() === binanceDexSwapTopic));

export function nativeSellProceeds(wallet: string, soldRaw: bigint, logs: TransferLog[], router?: string | null, soldToken?: string): bigint | null {
  const recipient = wallet.toLowerCase();
  const payouts: bigint[] = [];
  for (const log of logs) {
    if (flapRouters.has(log.address.toLowerCase()) && log.topics[0]?.toLowerCase() === flapSwapTopic &&
    addressFromTopic(log.topics[1]) === recipient && addressFromTopic(log.topics[2]) === recipient &&
    nativeAddresses.has(addressFromTopic(log.topics[3]) || '') && /^0x[0-9a-fA-F]{128,}$/.test(log.data) &&
    (!soldToken || !flapInputToken(log) || flapInputToken(log) === soldToken.toLowerCase()) &&
    sameQuantity(soldRaw, BigInt(`0x${log.data.slice(2, 66)}`), Boolean(soldToken && flapInputToken(log) === soldToken.toLowerCase()))) payouts.push(BigInt(`0x${log.data.slice(66, 130)}`));
    if (!soldToken) continue;
    for (const format of payoutFormats) {
      if (!format.routers.some(address => address === log.address.toLowerCase()) || log.topics[0]?.toLowerCase() !== format.topic) continue;
      const words = wordsOf(log, format.words);
      if (!words) continue;
      let to: string | null, token: string | null, output: string | null, quantity: string, paid: string;
      if (format.kind === 'indexedRecipient') {
        if (log.topics.length !== 2) continue;
        to = addressFromTopic(log.topics[1]); token = wordAddress(words[0]); output = wordAddress(words[1]);
        quantity = words[2]; paid = words[3];
      } else if (format.kind === 'recipientWord') {
        if (log.topics.length !== 1) continue;
        to = wordAddress(words[2]); token = wordAddress(words[0]); output = wordAddress(words[1]);
        quantity = words[3]; paid = words[4];
      } else if (format.kind === 'indexedAssets') {
        if (log.topics.length !== 4) continue;
        to = addressFromTopic(log.topics[1]); token = addressFromTopic(log.topics[2]); output = addressFromTopic(log.topics[3]);
        quantity = words[0]; paid = words[1];
      } else {
        if (log.topics.length !== 1 || wordAddress(words[0]) !== recipient) continue;
        to = wordAddress(words[3]); token = wordAddress(words[1]); output = wordAddress(words[2]);
        quantity = words[4]; paid = words[5];
      }
      if (to === recipient && token === soldToken.toLowerCase() && nativeAddresses.has(output || '') && sameQuantity(soldRaw, BigInt(`0x${quantity}`), true))
        payouts.push(BigInt(`0x${paid}`));
    }
  }
  if (payouts.length) return payouts.length === 1 && payouts[0] > 0n ? payouts[0] : null;
  // Binance DEX reports gross aggregator output and a separate native fee. Match the
  // recipient, input token/quantity and the exact unwrapped output before subtracting it.
  if (router?.toLowerCase() === binanceDexRouter && soldToken) {
    const outputs = logs.filter(log => log.address.toLowerCase() === binanceOutputRouter && log.topics[0]?.toLowerCase() === binanceOutputTopic);
    const fees = logs.filter(log => log.address.toLowerCase() === binanceDexRouter && log.topics[0]?.toLowerCase() === binanceDexSwapTopic);
    if (outputs.length !== 1 || fees.length !== 1) return null;
    const output = wordsOf(outputs[0], 6), fee = wordsOf(fees[0], 2);
    if (!output || !fee || outputs[0].topics.length !== 1 || fees[0].topics.length !== 2 ||
      wordAddress(output[1]) !== soldToken.toLowerCase() || !nativeAddresses.has(wordAddress(output[2]) || '') ||
      wordAddress(output[3]) !== recipient || BigInt(`0x${output[4]}`) !== soldRaw ||
      !nativeAddresses.has(addressFromTopic(fees[0].topics[1]) || '')) return null;
    const gross = BigInt(`0x${output[5]}`), charged = BigInt(`0x${fee[1]}`);
    const withdrawals = logs.filter(log => log.address.toLowerCase() === wrappedBnb && log.topics[0]?.toLowerCase() === withdrawalTopic &&
      addressFromTopic(log.topics[1]) === '0x52b7b9e768900e2cc509ff0109b900660431b5d7' && wordsOf(log, 1));
    if (withdrawals.length !== 1 || BigInt(withdrawals[0].data) !== gross || charged >= gross) return null;
    return gross - charged;
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
    // ERC-721 shares the Transfer signature but indexes its token ID and has no amount data.
    if (log.topics[0]?.toLowerCase() !== transferTopic || log.topics.length !== 3 ||
      !/^0x[a-fA-F0-9]{40}$/.test(log.address) || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
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
