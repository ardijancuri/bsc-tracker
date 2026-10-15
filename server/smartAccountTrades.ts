import type { TransferLog } from './swap.js';

// EntryPoint v0.7. A sender asserted by an arbitrary contract is not proof that
// the wallet initiated a trade. Keep this deployment allowlist explicit.
const entryPoints = new Set(['0x0000000071727de22e5e9d8baf0edac6f37da032']);
export const userOperationTopic = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
export const beforeExecutionTopic = '0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972';
const address = (raw: unknown) => typeof raw === 'string' && /^0x[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : null;
const topicAddress = (raw: unknown) => typeof raw === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(raw) ? `0x${raw.slice(-40).toLowerCase()}` : null;
type Transaction = { from: string; to?: string | null; value?: string };
type Receipt = { status?: string; logs: (TransferLog & { removed?: boolean })[] };
export interface WalletTransactionContext { logs: TransferLog[]; nativeValue: bigint; router: string | null }

/** Scope swap evidence to one authenticated successful user operation. The
 * BeforeExecution marker excludes validation events, and each UserOperationEvent
 * ends that operation's execution logs. Never attribute bundler value or another
 * account's swap/fee movements to this wallet.
 * https://github.com/eth-infinitism/account-abstraction/blob/v0.7.0/contracts/interfaces/IEntryPoint.sol */
function contexts(tx: Transaction, receipt: Receipt): Map<string, WalletTransactionContext> {
  const result = new Map<string, WalletTransactionContext>(), from = address(tx.from), to = address(tx.to);
  if (!from || receipt.status !== '0x1' || receipt.logs.some(log => log.removed)) return result;
  if (!to || !entryPoints.has(to)) {
    if (!/^0x[0-9a-f]+$/i.test(tx.value ?? '0x0')) return result;
    result.set(from, { logs: receipt.logs, nativeValue: BigInt(tx.value ?? '0x0'), router: to });
    return result;
  }
  const before = receipt.logs.map((log, index) => ({ log, index })).filter(({ log }) => log.address.toLowerCase() === to
    && log.topics[0]?.toLowerCase() === beforeExecutionTopic);
  if (before.length !== 1 || before[0].log.topics.length !== 1 || before[0].log.data !== '0x') return result;
  let start = before[0].index + 1;
  const seen = new Set<string>(), repeated = new Set<string>();
  for (let index = start; index < receipt.logs.length; index++) {
    const log = receipt.logs[index];
    if (log.address.toLowerCase() !== to || log.topics[0]?.toLowerCase() !== userOperationTopic) continue;
    const sender = topicAddress(log.topics[2]), paymaster = topicAddress(log.topics[3]);
    if (log.topics.length !== 4 || !/^0x[0-9a-f]{64}$/i.test(log.topics[1] ?? '') || !sender
      || sender === '0x' + '0'.repeat(40) || !paymaster || !/^0x[0-9a-f]{256}$/i.test(log.data)) return new Map();
    const words = log.data.slice(2).match(/.{64}/g)!;
    const success = BigInt(`0x${words[1]}`);
    if (success !== 0n && success !== 1n) return new Map();
    if (seen.has(sender)) repeated.add(sender);
    seen.add(sender);
    // A paymaster can charge ERC-20 fees in postOp before this event. Without a
    // separate execution boundary those debits could look like swap quote cash.
    if (success === 1n && paymaster === '0x' + '0'.repeat(40)) result.set(sender, { logs: receipt.logs.slice(start, index), nativeValue: 0n, router: null });
    start = index + 1;
  }
  // The trade schema has one row per wallet/token/transaction. Multiple user
  // operations could buy and sell the same token; netting those loses cash flows.
  for (const sender of repeated) result.delete(sender);
  return result;
}

export function transactionWallets(tx: Transaction, receipt: Receipt): string[] { return [...contexts(tx, receipt).keys()]; }
export function walletTransactionContext(tx: Transaction, receipt: Receipt, wallet: string): WalletTransactionContext | null {
  return contexts(tx, receipt).get(wallet.toLowerCase()) ?? null;
}
