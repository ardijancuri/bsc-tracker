import { Wallet, ZeroAddress, getAddress, keccak256, parseEther, toQuantity } from 'ethers';
import { browserApi } from './platform';
import { WalletBroadcastRejection, parseRpcQuantity, walletRpc } from './walletRpc';
import { pendingWalletBuyKey, walletTransactionLockKey } from './walletTransactionKeys';
import { exportLocalWallet } from './walletVault';

const chainId = 56;
const reviewLifetime = 120_000;
const addressPattern = /^0x[\da-f]{40}$/i;
const hashPattern = /^0x[\da-f]{64}$/i;

interface TransferDetails {
  from: string;
  to: string;
  value: string;
  gasPrice: string;
  gasLimit: string;
  nonce: number;
}

export interface TransferPreview extends TransferDetails {
  reviewedAt: number;
}

export interface PendingWalletTransfer extends TransferDetails {
  hash: string;
}

export type TransferStatus = 'pending' | 'unknown' | 'confirmed' | 'reverted' | 'nonce_used';

class WalletTransferError extends Error {}

export function transferErrorMessage(error: unknown, fallback: string): string {
  return error instanceof WalletTransferError ? error.message : fallback;
}

export function maximumTransferFee(transfer: TransferDetails): bigint {
  return BigInt(transfer.gasPrice) * BigInt(transfer.gasLimit);
}

function transferInput(recipient: string, amount: string) {
  let to: string;
  try {
    if (!addressPattern.test(recipient)) throw new Error();
    to = getAddress(recipient);
  } catch {
    throw new WalletTransferError('Enter a valid BNB Chain address.');
  }
  if (to === ZeroAddress) throw new WalletTransferError('Choose a recipient other than the zero address.');
  if (!/^(?:\d{1,24}(?:\.\d{1,18})?|\.\d{1,18})$/.test(amount)) {
    throw new WalletTransferError('Enter an amount with up to 18 decimal places.');
  }
  const value = parseEther(amount);
  if (value <= 0n) throw new WalletTransferError('Enter an amount greater than zero.');
  return { to, value };
}

async function requireBnbChain(): Promise<void> {
  if (parseRpcQuantity(await walletRpc('eth_chainId', [])) !== BigInt(chainId)) {
    throw new WalletTransferError('The RPC is connected to a different network.');
  }
}

async function requireNoPendingBuy(from: string) {
  const key = pendingWalletBuyKey(from);
  const pending: unknown = (await browserApi.storage.local.get(key))[key];
  if (pending !== undefined && (!Array.isArray(pending) || pending.length > 0)) {
    throw new WalletTransferError('Check pending token purchases before sending BNB.');
  }
}

export async function loadPendingWalletTransfer(from: string): Promise<PendingWalletTransfer | null> {
  const key = walletTransactionLockKey(from);
  const item: unknown = (await browserApi.storage.local.get(key))[key];
  if (item === undefined) return null;
  if (!item || typeof item !== 'object') throw new Error('Invalid saved transaction.');
  const transfer = item as PendingWalletTransfer;
  if (transfer.from !== from || !addressPattern.test(transfer.to) || !hashPattern.test(transfer.hash)
    || ![transfer.value, transfer.gasPrice, transfer.gasLimit].every(
      value => typeof value === 'string' && /^[1-9]\d{0,77}$/.test(value),
    ) || !Number.isSafeInteger(transfer.nonce) || transfer.nonce < 0) {
    throw new Error('Invalid saved transaction.');
  }
  return transfer;
}

export async function previewWalletTransfer(from: string, recipient: string, amount: string): Promise<TransferPreview> {
  const { to, value } = transferInput(recipient, amount);
  await requireNoPendingBuy(from);
  if (await loadPendingWalletTransfer(from)) {
    throw new WalletTransferError('Check the previous transaction before sending again.');
  }
  await requireBnbChain();
  const [balance, gasPrice, nonce] = (await Promise.all([
    walletRpc('eth_getBalance', [from, 'pending']),
    walletRpc('eth_gasPrice', []),
    walletRpc('eth_getTransactionCount', [from, 'pending']),
  ])).map(parseRpcQuantity);
  if (balance < value) throw new WalletTransferError('This wallet has insufficient BNB.');
  const estimate = parseRpcQuantity(await walletRpc('eth_estimateGas', [
    { from, to, value: toQuantity(value), gasPrice: toQuantity(gasPrice) },
  ]));
  const gasLimit = estimate === 21_000n ? estimate : (estimate * 120n + 99n) / 100n;
  if (estimate < 21_000n || gasLimit > 1_000_000n || gasPrice === 0n || nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WalletTransferError('The network could not provide a valid transfer estimate.');
  }
  if (balance < value + gasLimit * gasPrice) {
    throw new WalletTransferError('This wallet has insufficient BNB for the amount and network fee.');
  }
  return {
    from, to, value: value.toString(), gasPrice: gasPrice.toString(), gasLimit: gasLimit.toString(),
    nonce: Number(nonce), reviewedAt: Date.now(),
  };
}

async function signWalletTransfer(transfer: TransferDetails, password?: string): Promise<string> {
  let wallet: Wallet;
  try {
    wallet = new Wallet(await exportLocalWallet(transfer.from, password));
  } catch {
    throw new WalletTransferError('Could not unlock this wallet.');
  }
  if (wallet.address !== transfer.from) throw new WalletTransferError('The selected wallet changed.');
  return wallet.signTransaction({
    type: 0, chainId, to: transfer.to, value: transfer.value,
    gasLimit: transfer.gasLimit, gasPrice: transfer.gasPrice, nonce: transfer.nonce,
  });
}

async function broadcastWalletTransfer(raw: string, hash: string) {
  try {
    const result = await walletRpc('eth_sendRawTransaction', [raw]);
    if (typeof result === 'string' && result.toLowerCase() === hash) return 'pending' as const;
  } catch (failure) {
    if (failure instanceof WalletBroadcastRejection) return failure.reason;
  }
  // A timeout or unexpected provider response can arrive after admission.
  return 'unknown' as const;
}

export async function submitWalletTransfer(preview: TransferPreview, password?: string): Promise<{
  transfer: PendingWalletTransfer;
  status: 'pending' | 'unknown';
}> {
  const { reviewedAt, ...details } = preview;
  const key = walletTransactionLockKey(details.from);
  return navigator.locks.request(key, async () => {
    if (Date.now() - reviewedAt > reviewLifetime) {
      throw new WalletTransferError('This review expired. Review the transfer again.');
    }
    if (await loadPendingWalletTransfer(details.from)) {
      throw new WalletTransferError('Check the previous transaction before sending again.');
    }
    await requireNoPendingBuy(details.from);
    await requireBnbChain();
    const [balance, nonce] = (await Promise.all([
      walletRpc('eth_getBalance', [details.from, 'pending']),
      walletRpc('eth_getTransactionCount', [details.from, 'pending']),
    ])).map(parseRpcQuantity);
    if (nonce !== BigInt(details.nonce)) {
      throw new WalletTransferError('Wallet activity changed. Review the transfer again.');
    }
    if (balance < BigInt(details.value) + maximumTransferFee(details)) {
      throw new WalletTransferError('This wallet has insufficient BNB for the amount and network fee.');
    }
    const raw = await signWalletTransfer(details, password);
    const transfer = { ...details, hash: keccak256(raw) };
    // Save public fields before broadcast so an interrupted popup can reconcile the same nonce.
    await browserApi.storage.local.set({ [key]: transfer });
    const status = await broadcastWalletTransfer(raw, transfer.hash);
    if (status === 'pending' || status === 'unknown') return { transfer, status };
    // Only the initial broadcast can establish that the transaction was never admitted.
    try {
      await browserApi.storage.local.remove(key);
      if (await loadPendingWalletTransfer(details.from)) return { transfer, status: 'unknown' };
    } catch {
      await browserApi.storage.local.set({ [key]: transfer }).catch(() => {});
      return { transfer, status: 'unknown' };
    }
    throw new WalletTransferError(status === 'fee_rejected'
      ? 'The network rejected the fee. Go back to review an updated fee.'
      : 'The network rejected the transfer because this wallet has insufficient BNB.');
  });
}

async function inspectWalletTransfer(transfer: PendingWalletTransfer): Promise<TransferStatus> {
  await requireBnbChain();
  const receipt = await walletRpc('eth_getTransactionReceipt', [transfer.hash]);
  if (receipt !== null) {
    const { transactionHash, status } = receipt as { transactionHash?: unknown; status?: unknown };
    if (typeof transactionHash !== 'string' || transactionHash.toLowerCase() !== transfer.hash) {
      throw new Error('Unexpected transaction receipt.');
    }
    const code = parseRpcQuantity(status);
    if (code === 1n) return 'confirmed';
    if (code === 0n) return 'reverted';
    throw new Error('Invalid transaction status.');
  }
  const transaction = await walletRpc('eth_getTransactionByHash', [transfer.hash]);
  if (transaction !== null) {
    const { hash } = transaction as { hash?: unknown };
    if (typeof hash === 'string' && hash.toLowerCase() === transfer.hash) return 'pending';
    throw new Error('Unexpected transaction result.');
  }
  const latestNonce = parseRpcQuantity(await walletRpc('eth_getTransactionCount', [transfer.from, 'latest']));
  return latestNonce > BigInt(transfer.nonce) ? 'nonce_used' : 'unknown';
}

export async function checkWalletTransfer(transfer: PendingWalletTransfer, retry?: { password?: string }) {
  const key = walletTransactionLockKey(transfer.from);
  return navigator.locks.request(key, async () => {
    const current = await loadPendingWalletTransfer(transfer.from);
    if (!current || current.hash !== transfer.hash) {
      throw new WalletTransferError('This transaction was already checked. Close and reopen Send.');
    }
    const status = await inspectWalletTransfer(current);
    if (status === 'confirmed' || status === 'reverted' || status === 'nonce_used') {
      await browserApi.storage.local.remove(key);
    } else if (status === 'unknown' && retry) {
      const raw = await signWalletTransfer(current, retry.password);
      if (keccak256(raw) !== current.hash) {
        throw new WalletTransferError('Could not reproduce the original transaction.');
      }
      // Even a definite rejection on retry cannot resolve the earlier attempt.
      return await broadcastWalletTransfer(raw, current.hash) === 'pending' ? 'pending' : 'unknown';
    }
    return status;
  });
}
