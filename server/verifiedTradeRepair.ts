import { hasRecognizedSwap, walletSwapFlows, type TransferLog } from './swap.js';
import { walletTransactionContext } from './smartAccountTrades.js';
import type { KolTokenTradeRepairHint } from './kolTokenTradeRepair.js';

type Tx = { hash: string; from: string; to: string | null; value: string; blockNumber: string; blockHash?: string; transactionIndex: string | null };
type Receipt = { status: string; blockHash: string; blockNumber?: string; transactionHash?: string;
  logs: (TransferLog & { transactionHash: string; blockNumber: string; removed?: boolean })[] };
type Block = { number: string; hash: string };
const hex = /^0x[0-9a-f]+$/i;

/** A queue hint never authorizes an insert by itself. Re-read the confirmed
 * canonical transaction, receipt and block, then authenticate the initiating
 * wallet and the selected token flow inside its own operation. */
export function verifiedTradeRepair(hint: KolTokenTradeRepairHint, tx: Tx | null, receipt: Receipt | null, block: Block | null, head: number): boolean {
  if (!tx || !receipt || !block || !Number.isSafeInteger(head) || !hex.test(tx.blockNumber) || !hex.test(block.number)
    || !hex.test(receipt.blockNumber ?? '') || !hex.test(tx.transactionIndex ?? '') || !/^\d+$/.test(hint.blockNumber)) return false;
  const height = BigInt(hint.blockNumber);
  if (height > BigInt(Math.max(0, head - 6)) || BigInt(tx.blockNumber) !== height || BigInt(block.number) !== height || BigInt(receipt.blockNumber!) !== height
    || tx.hash.toLowerCase() !== hint.txHash || receipt.transactionHash?.toLowerCase() !== hint.txHash
    || block.hash.toLowerCase() !== hint.blockHash || tx.blockHash?.toLowerCase() !== hint.blockHash || receipt.blockHash.toLowerCase() !== hint.blockHash
    || receipt.logs.some(log => log.removed || log.transactionHash.toLowerCase() !== hint.txHash || !hex.test(log.blockNumber) || BigInt(log.blockNumber) !== height)) return false;
  const context = walletTransactionContext(tx, receipt, hint.walletAddress);
  return !!context && hasRecognizedSwap(context.logs)
    && (walletSwapFlows(hint.walletAddress, context.nativeValue, context.logs).get(hint.tokenAddress) ?? 0n) !== 0n;
}
