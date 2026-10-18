import { userOperationTopic } from './smartAccountTrades.js';
const entryPoints = new Set(['0x0000000071727de22e5e9d8baf0edac6f37da032']);
const address = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const integer = (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) && value.length <= 66 ? BigInt(value) : null;
type FeeTx = { hash: string; from: string; to?: string | null; gasPrice?: string };
type FeeReceipt = { status?: string; gasUsed?: string; effectiveGasPrice?: string;
  logs: { address: string; topics: string[]; data: string; removed?: boolean }[] };
export interface JournalNodeFeeEvidence {
  payer: string; complete: boolean; reason?: string;
  fees: { id: string; nativeWei: string; kind: 'transaction' | 'user_operation' }[];
}

/** Only fees attributable to the selected wallet. The bundler's transaction gas
 * is never charged to a smart wallet. Sponsored ERC-20 fees need a decoder and
 * remain unknown here. USD conversion is a separate observed valuation. */
export function journalNodeFees(tx: FeeTx, receipt: FeeReceipt, walletAddress: string): JournalNodeFeeEvidence {
  const wallet = address(walletAddress), from = address(tx.from), to = address(tx.to), hash = tx.hash.toLowerCase();
  const result: JournalNodeFeeEvidence = { payer: wallet || walletAddress, complete: false, fees: [] };
  if (!wallet || !from || !/^0x[0-9a-f]{64}$/.test(hash) || receipt.logs.some(log => log.removed) || !['0x0', '0x1'].includes(receipt.status || '')) return { ...result, reason: 'fee_evidence_invalid' };
  if (wallet === from) {
    const gas = integer(receipt.gasUsed), price = integer(receipt.effectiveGasPrice ?? tx.gasPrice);
    if (gas == null || price == null) return { ...result, reason: 'transaction_fee_unavailable' };
    return { payer: wallet, complete: true, fees: [{ id: `${hash}:transaction:${wallet}`, nativeWei: (gas * price).toString(), kind: 'transaction' }] };
  }
  if (!to || !entryPoints.has(to)) return { ...result, reason: 'wallet_fee_payer_unknown' };
  const seen = new Set<string>();
  for (const log of receipt.logs) {
    if (address(log.address) !== to || log.topics[0]?.toLowerCase() !== userOperationTopic) continue;
    const sender = /^0x0{24}[0-9a-f]{40}$/i.test(log.topics[2] || '') ? `0x${log.topics[2].slice(-40)}`.toLowerCase() : null;
    if (sender !== wallet) continue;
    if (log.topics.length !== 4 || !/^0x[0-9a-f]{64}$/i.test(log.topics[1]) || !/^0x[0-9a-f]{256}$/i.test(log.data)
      || !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[3])) return { ...result, reason: 'operation_fee_evidence_invalid' };
    const operation = log.topics[1].toLowerCase(), paymaster = `0x${log.topics[3].slice(-40)}`.toLowerCase();
    if (paymaster !== `0x${'0'.repeat(40)}`) return { ...result, reason: 'sponsored_operation_fee_unknown' };
    if (seen.has(operation)) return { ...result, reason: 'operation_fee_duplicate' };
    seen.add(operation);
    const words = log.data.slice(2).match(/.{64}/g)!;
    if (BigInt(`0x${words[1]}`) > 1n) return { ...result, reason: 'operation_fee_evidence_invalid' };
    result.fees.push({ id: `${hash}:operation:${operation}:${wallet}`, nativeWei: BigInt(`0x${words[2]}`).toString(), kind: 'user_operation' });
  }
  return result.fees.length ? { ...result, complete: true } : { ...result, reason: 'operation_fee_unavailable' };
}
