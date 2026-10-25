import { Interface } from 'ethers';
import { FLAP_PORTAL, WBNB, flapInterface } from '../launchpad.js';
import { transferTopic } from '../swap.js';
import { freshAddress, freshHash, freshInteger, type FreshCapturedReceipt, type FreshLog } from './capture.js';
import type { FreshPriceBlock } from './pricing.js';

// Official IPortal events: github.com/flap-sh/FlapVaultExample/src/flap/IPortal.sol.
// These amounts are raw quote-token units, despite the legacy `eth` field name.
const abi = new Interface([
  'event TokenQuoteSet(address token,address quoteToken)',
  'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
]);
export interface FreshDirectFlapPurchase {
  version: 1; kind: 'direct_flap_gross_quote_purchase';
  transactionHash: string; blockNumber: number; blockHash: string; transactionIndex: number;
  walletAddress: string; tokenAddress: string; quoteAddress: string;
  tokenRaw: string; quoteRaw: string; embeddedQuoteFeeRaw: string; gasFeeWei: string;
  creationLogIndex: number; quoteLogIndex: number; purchaseLogIndex: number;
  quoteTransferLogIndex: number; tokenTransferLogIndex: number;
}
const topicAddress = (value: unknown) => typeof value === 'string' && /^0x0{24}[\da-f]{40}$/.test(value) ? '0x' + value.slice(-40) : null;
function parsedEvent(log: FreshLog, schema: Interface) {
  try {
    const event = schema.parseLog(log); if (!event) return null;
    const encoded = schema.encodeEventLog(event.fragment, [...event.args]);
    return encoded.data === log.data && JSON.stringify(encoded.topics) === JSON.stringify(log.topics) ? event : null;
  } catch { return null; }
}

/** Intentionally narrow: one ordinary EOA creates and buys one ERC20-quoted
 * token directly through the authenticated portal. Its receipt proves the
 * entire gross payment and target delivery; the embedded portal fee is already
 * in that gross payment. EIP-7702/AA wrappers, native inputs, change, multiple
 * actions and ambiguous wallet flows remain in their existing repair paths. */
export function freshDirectFlapPurchase(entry: FreshCapturedReceipt, block: FreshPriceBlock,
  tokenAddress: string, walletAddress: string, receivedRaw: bigint): FreshDirectFlapPurchase | null {
  try {
    const { transaction: tx, receipt } = entry, token = freshAddress(tokenAddress), wallet = freshAddress(walletAddress);
    if (!token || !wallet || receivedRaw <= 0n || tx.from !== wallet || tx.to !== FLAP_PORTAL || !entry.wallets.includes(wallet)
      || !['0x0', '0x1', '0x2'].includes(String(tx.type)) || tx.authorizationList !== undefined
      || freshInteger(tx.value) !== 0n || receipt.status !== '0x1' || !freshHash(tx.hash)
      || tx.blockHash !== block.hash || receipt.blockHash !== block.hash || receipt.transactionHash !== tx.hash
      || Number(freshInteger(tx.blockNumber)) !== block.number || receipt.blockNumber !== tx.blockNumber
      || receipt.transactionIndex !== tx.transactionIndex || !Number.isSafeInteger(block.number)
      || !Number.isFinite(Date.parse(block.timestamp)) || !Array.isArray(receipt.logs) || receipt.logs.length > 512) return null;
    const gas = freshInteger(receipt.gasUsed), gasPrice = freshInteger(receipt.effectiveGasPrice ?? tx.gasPrice);
    if (gas <= 0n || gasPrice <= 0n) return null;
    let previous = -1;
    for (const log of receipt.logs) {
      const index = Number(freshInteger(log.logIndex));
      if (log.removed || !freshAddress(log.address) || !Array.isArray(log.topics) || log.topics.length > 4
        || !log.topics.every(freshHash) || !/^0x(?:[\da-f]{2})*$/.test(log.data) || log.data.length > 65538
        || log.blockHash !== block.hash || log.blockNumber !== tx.blockNumber || log.transactionHash !== tx.hash
        || log.transactionIndex !== tx.transactionIndex || !Number.isSafeInteger(index) || index <= previous) return null;
      previous = index;
    }
    const portal = receipt.logs.filter(log => log.address === FLAP_PORTAL);
    const exactTopics = new Set(['TokenQuoteSet', 'TokenBought', 'TokenSold'].map(name => abi.getEvent(name)!.topicHash));
    if (portal.some(log => exactTopics.has(log.topics[0]) && !parsedEvent(log, abi)
      || log.topics[0] === flapInterface.getEvent('TokenCreated')!.topicHash && !parsedEvent(log, flapInterface))) return null;
    const creations = portal.map(log => ({ log, event: parsedEvent(log, flapInterface) })).filter(value => value.event?.name === 'TokenCreated');
    const quotes = portal.map(log => ({ log, event: parsedEvent(log, abi) })).filter(value => value.event?.name === 'TokenQuoteSet');
    const actions = portal.map(log => ({ log, event: parsedEvent(log, abi) })).filter(value => ['TokenBought', 'TokenSold'].includes(value.event?.name ?? ''));
    if (creations.length !== 1 || quotes.length !== 1 || actions.length !== 1) return null;
    const creation = creations[0], quote = quotes[0], action = actions[0];
    const quoteAddress=freshAddress(String(quote.event!.args.quoteToken).toLowerCase());
    if(!quoteAddress||[token,wallet,FLAP_PORTAL,WBNB,`0x${'0'.repeat(40)}`].includes(quoteAddress))return null;
    if (String(creation.event!.args.token).toLowerCase() !== token || String(creation.event!.args.creator).toLowerCase() !== wallet
      || String(quote.event!.args.token).toLowerCase() !== token
      || action.event!.name !== 'TokenBought' || String(action.event!.args.token).toLowerCase() !== token
      || String(action.event!.args.buyer).toLowerCase() !== wallet || BigInt(action.event!.args.amount) !== receivedRaw
      || BigInt(action.event!.args.ts) !== BigInt(Math.floor(Date.parse(block.timestamp) / 1000))) return null;
    const quoteRaw = BigInt(action.event!.args.eth), embeddedFee = BigInt(action.event!.args.fee);
    if (quoteRaw <= 0n || embeddedFee < 0n || embeddedFee > quoteRaw) return null;
    const walletFlows = receipt.logs.filter(log => log.topics[0] === transferTopic && log.topics.length === 3
      && (topicAddress(log.topics[1]) === wallet || topicAddress(log.topics[2]) === wallet));
    if (walletFlows.length !== 2) return null;
    const payment = walletFlows.find(log => log.address === quoteAddress && topicAddress(log.topics[1]) === wallet && topicAddress(log.topics[2]) === FLAP_PORTAL);
    const delivery = walletFlows.find(log => log.address === token && topicAddress(log.topics[1]) === FLAP_PORTAL && topicAddress(log.topics[2]) === wallet);
    if (!payment || !delivery || !/^0x[\da-f]{64}$/.test(payment.data) || !/^0x[\da-f]{64}$/.test(delivery.data)
      || BigInt(payment.data) !== quoteRaw || BigInt(delivery.data) !== receivedRaw) return null;
    const index = (log: FreshLog) => Number(freshInteger(log.logIndex));
    if (index(creation.log) >= index(quote.log) || index(quote.log) >= index(payment) || index(payment) >= index(delivery) || index(delivery) >= index(action.log)) return null;
    return { version: 1, kind: 'direct_flap_gross_quote_purchase', transactionHash: tx.hash, blockNumber: block.number, blockHash: block.hash,
      transactionIndex: Number(freshInteger(tx.transactionIndex)), walletAddress: wallet, tokenAddress: token, quoteAddress,
      tokenRaw: String(receivedRaw), quoteRaw: String(quoteRaw), embeddedQuoteFeeRaw: String(embeddedFee), gasFeeWei: String(gas * gasPrice),
      creationLogIndex: index(creation.log), quoteLogIndex: index(quote.log), purchaseLogIndex: index(action.log),
      quoteTransferLogIndex: index(payment), tokenTransferLogIndex: index(delivery) };
  } catch { return null; }
}
