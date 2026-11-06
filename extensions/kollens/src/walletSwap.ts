import { Interface, Wallet, ZeroAddress, getAddress, keccak256, parseEther, toQuantity } from 'ethers';
import { browserApi } from './platform';
import { quoteLaunchpadBuy } from './walletBuyLaunchpads';
import { WalletBroadcastRejection, parseRpcQuantity, walletRpc } from './walletRpc';
import { pendingWalletBuyKey, walletTransactionLockKey } from './walletTransactionKeys';
import { loadPendingWalletTransfer } from './walletTransfer';
import { exportLocalWallet, listLocalWallets } from './walletVault';

export const maxWalletBuyTrades = 24;
export const maxWalletBuySlippageBps = 2500;
const chainId = 56;
const reviewLifetimeMs = 90_000;
const maximumGasLimit = 1_500_000n;
// PancakeSwap's published BNB Chain V2 deployment and its wrapped native token.
// https://developer.pancakeswap.finance/contracts/v2/addresses
const pancakeRouter = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const wrappedBnb = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const pancake = new Interface([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 minOut, address[] path, address recipient, uint256 deadline) payable',
]);
const tokenAbi = new Interface(['function decimals() view returns (uint8)']);
const addressPattern = /^0x[\da-f]{40}$/i;
const hashPattern = /^0x[\da-f]{64}$/i;

export interface WalletBuyQuote {
  readonly wallet: string;
  readonly token: string;
  readonly provider: string;
  readonly amountInWei: string;
  readonly quotedOut: string;
  readonly minimumOut: string;
  readonly decimals: number;
  readonly maxFeeWei: string;
}

export interface WalletBuyPlan {
  readonly trades: readonly WalletBuyQuote[];
  readonly totalInputWei: string;
  readonly totalMaxFeeWei: string;
  readonly expiresAt: number;
  readonly slippageBps: number;
}

export interface PendingWalletBuy {
  readonly wallet: string;
  readonly token: string;
  readonly hash: string;
  readonly nonce: number;
}

export interface WalletBuyResult {
  wallet: string;
  token: string;
  status: 'submitted' | 'unknown' | 'failed' | 'skipped' | 'confirmed' | 'reverted' | 'nonce_used';
  hash?: string;
  message?: string;
}

interface PreparedBuy {
  quote: WalletBuyQuote;
  to: string;
  data: string;
  gasPrice: bigint;
  gasLimit: bigint;
  nonce: number;
}

interface BuyRoute {
  provider: string;
  expectedOut: bigint;
  buildData(minimumOut: bigint): { to: string; data: string; value: bigint };
}

class WalletBuyError extends Error {}

// Executable calldata stays private and tied to the exact plan checked before submission.
const preparedPlans = new WeakMap<WalletBuyPlan, readonly PreparedBuy[]>();

export function walletBuyErrorMessage(error: unknown, fallback: string): string {
  return error instanceof WalletBuyError ? error.message : fallback;
}

function reviewAddresses(addresses: readonly string[], label: string): string[] {
  try {
    return [...new Set(addresses.map(address => {
      if (!addressPattern.test(address)) throw new Error();
      const normalized = getAddress(address);
      if (normalized === ZeroAddress) throw new Error();
      return normalized;
    }))];
  } catch {
    throw new WalletBuyError(`A ${label} address is invalid.`);
  }
}

export function parseWalletBuyAmount(amount: string): bigint {
  if (!/^(?:\d{1,24}(?:\.\d{1,18})?|\.\d{1,18})$/.test(amount)) {
    throw new WalletBuyError('Enter a BNB amount with up to 18 decimal places.');
  }
  const value = parseEther(amount);
  if (value <= 0n) throw new WalletBuyError('Enter a BNB amount greater than zero.');
  return value;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

async function requireBnbChain(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (parseRpcQuantity(await walletRpc('eth_chainId', [], signal)) !== BigInt(chainId)) {
    throw new WalletBuyError('The RPC is connected to a different network.');
  }
}

async function readQuantity(method: string, params: unknown[], signal?: AbortSignal): Promise<bigint> {
  return parseRpcQuantity(await walletRpc(method, params, signal));
}

async function requireActiveWallets(addresses: readonly string[]): Promise<void> {
  const active = new Set((await listLocalWallets()).filter(wallet => !wallet.archived).map(wallet => wallet.address));
  if (addresses.some(address => !active.has(address))) {
    throw new WalletBuyError('A selected wallet is unavailable. Choose active wallets and try again.');
  }
}

export async function loadPendingWalletBuys(wallet: string): Promise<PendingWalletBuy[]> {
  const key = pendingWalletBuyKey(wallet);
  const stored: unknown = (await browserApi.storage.local.get(key))[key];
  if (stored === undefined) return [];
  if (!Array.isArray(stored) || stored.length > maxWalletBuyTrades || stored.some(record =>
    !record || typeof record !== 'object' || record.wallet !== wallet ||
    typeof record.token !== 'string' || !addressPattern.test(record.token) ||
    typeof record.hash !== 'string' || !hashPattern.test(record.hash) ||
    !Number.isSafeInteger(record.nonce) || record.nonce < 0
  )) {
    throw new WalletBuyError('Could not read pending purchases for this wallet.');
  }
  return stored;
}

async function requireNoWalletTransactions(wallet: string): Promise<void> {
  if ((await loadPendingWalletBuys(wallet)).length) {
    throw new WalletBuyError(`Check pending purchases for ${shortAddress(wallet)} before buying again.`);
  }
  if (await loadPendingWalletTransfer(wallet)) {
    throw new WalletBuyError(`Check the pending BNB transfer for ${shortAddress(wallet)} before buying.`);
  }
}

async function readTokenDecimals(token: string, signal?: AbortSignal): Promise<number> {
  const data = tokenAbi.encodeFunctionData('decimals');
  const result = await walletRpc('eth_call', [{ to: token, data }, 'latest'], signal);
  if (typeof result !== 'string' || !/^0x[\da-f]{64}$/i.test(result)) {
    throw new WalletBuyError(`Could not read token decimals for ${shortAddress(token)}.`);
  }
  const decimals = BigInt(result);
  if (decimals > 80n) throw new WalletBuyError(`Unsupported token precision for ${shortAddress(token)}.`);
  return Number(decimals);
}

async function quotePancake(token: string, value: bigint, signal?: AbortSignal): Promise<bigint | null> {
  try {
    const data = pancake.encodeFunctionData('getAmountsOut', [value, [wrappedBnb, token]]);
    const result = await walletRpc('eth_call', [{ to: pancakeRouter, data }, 'latest'], signal);
    if (typeof result !== 'string' || !/^0x[\da-f]{256}$/i.test(result)) return null;
    const [amounts] = pancake.decodeFunctionResult('getAmountsOut', result);
    return amounts.length === 2 && amounts[0] === value && amounts[1] > 0n ? amounts[1] : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function quoteRoute(wallet: string, token: string, value: bigint, pancakeOut: bigint | null,
  deadline: number, signal?: AbortSignal): Promise<BuyRoute> {
  const launchpad = await quoteLaunchpadBuy({
    token, wallet, value, signal,
    rpc: (method, params) => walletRpc(method, params, signal),
  });
  signal?.throwIfAborted();
  // An active first-party bonding curve takes priority over a permissionless pool.
  if (launchpad) {
    return {
      provider: launchpad.kind === 'fourmeme' ? 'Four.Meme' : 'Flap',
      expectedOut: launchpad.estimatedOutput,
      buildData: launchpad.buildData,
    };
  }
  if (pancakeOut === null) throw new WalletBuyError(`No supported BNB buy route for ${shortAddress(token)}.`);
  return {
    provider: 'PancakeSwap V2',
    expectedOut: pancakeOut,
    buildData: minimumOut => ({
      to: pancakeRouter,
      value,
      data: pancake.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [
        minimumOut, [wrappedBnb, token], wallet, deadline,
      ]),
    }),
  };
}

async function estimateSwap(wallet: string, token: string, to: string, data: string,
  value: bigint, gasPrice: bigint, signal?: AbortSignal): Promise<bigint> {
  let estimate: bigint;
  try {
    estimate = await readQuantity('eth_estimateGas', [
      { from: wallet, to, data, value: toQuantity(value), gasPrice: toQuantity(gasPrice) },
    ], signal);
  } catch {
    signal?.throwIfAborted();
    throw new WalletBuyError(`The purchase of ${shortAddress(token)} could not be simulated for ${shortAddress(wallet)}. Check the amount and slippage.`);
  }
  const gasLimit = (estimate * 120n + 99n) / 100n;
  if (estimate < 21_000n || gasLimit > maximumGasLimit) {
    throw new WalletBuyError(`Invalid network fee estimate for ${shortAddress(token)}.`);
  }
  return gasLimit;
}

async function inSmallBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += 4) {
    results.push(...await Promise.all(items.slice(index, index + 4).map(run)));
  }
  return results;
}

export async function previewWalletBuys(walletAddresses: readonly string[], tokenAddresses: readonly string[],
  amountPerBuy: string, slippageBps: number, signal?: AbortSignal): Promise<WalletBuyPlan> {
  const wallets = reviewAddresses(walletAddresses, 'wallet');
  const tokens = reviewAddresses(tokenAddresses, 'token');
  if (!wallets.length || !tokens.length) throw new WalletBuyError('Choose at least one wallet and token.');
  if (wallets.length * tokens.length > maxWalletBuyTrades) {
    throw new WalletBuyError(`Buy up to ${maxWalletBuyTrades} orders at once.`);
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > maxWalletBuySlippageBps) {
    throw new WalletBuyError('Enter slippage from 0.01% to 25%.');
  }
  const value = parseWalletBuyAmount(amountPerBuy);
  await requireActiveWallets(wallets);
  await requireBnbChain(signal);
  const expiresAt = Date.now() + reviewLifetimeMs;
  const deadline = Math.floor(expiresAt / 1000) + 30;
  const gasPrice = await readQuantity('eth_gasPrice', [], signal);
  if (gasPrice === 0n) throw new WalletBuyError('The network could not provide a valid gas price.');

  const walletDetails = await inSmallBatches(wallets, async wallet => {
    await requireNoWalletTransactions(wallet);
    const [balance, nonce] = await Promise.all([
      readQuantity('eth_getBalance', [wallet, 'pending'], signal),
      readQuantity('eth_getTransactionCount', [wallet, 'pending'], signal),
    ]);
    if (balance < value * BigInt(tokens.length)) {
      throw new WalletBuyError(`Insufficient BNB in ${shortAddress(wallet)} for these purchases.`);
    }
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER - tokens.length)) {
      throw new WalletBuyError('The network returned an invalid wallet nonce.');
    }
    return { wallet, balance, nonce: Number(nonce) };
  });
  const tokenDetails = await inSmallBatches(tokens, async token => {
    const [decimals, pancakeOut] = await Promise.all([
      readTokenDecimals(token, signal), quotePancake(token, value, signal),
    ]);
    return { token, decimals, pancakeOut };
  });
  const combinations = walletDetails.flatMap(({ wallet, nonce }) => tokenDetails.map((token, index) => ({
    wallet, ...token, nonce: nonce + index,
  })));
  const prepared = await inSmallBatches(combinations, async ({ wallet, token, decimals, pancakeOut, nonce }) => {
    const route = await quoteRoute(wallet, token, value, pancakeOut, deadline, signal);
    const minimumOut = route.expectedOut * BigInt(10_000 - slippageBps) / 10_000n;
    if (minimumOut <= 0n) throw new WalletBuyError(`Amount is too small to buy ${shortAddress(token)}.`);
    const { to, data, value: routeValue } = route.buildData(minimumOut);
    if (routeValue !== value || !addressPattern.test(to) || to === ZeroAddress ||
      !/^0x(?:[\da-f]{2}){4,4096}$/i.test(data)) {
      throw new WalletBuyError('The purchase route returned an invalid transaction.');
    }
    const gasLimit = await estimateSwap(wallet, token, to, data, value, gasPrice, signal);
    const quote: WalletBuyQuote = Object.freeze({
      wallet, token, provider: route.provider, amountInWei: value.toString(), quotedOut: route.expectedOut.toString(),
      minimumOut: minimumOut.toString(), decimals, maxFeeWei: (gasPrice * gasLimit).toString(),
    });
    return { quote, to, data, gasPrice, gasLimit, nonce };
  });
  const fees = new Map<string, bigint>();
  let totalMaxFeeWei = 0n;
  for (const { quote } of prepared) {
    const fee = BigInt(quote.maxFeeWei);
    fees.set(quote.wallet, (fees.get(quote.wallet) ?? 0n) + fee);
    totalMaxFeeWei += fee;
  }
  for (const { wallet, balance } of walletDetails) {
    if (balance < value * BigInt(tokens.length) + fees.get(wallet)!) {
      throw new WalletBuyError(`Insufficient BNB in ${shortAddress(wallet)} for the purchases and network fees.`);
    }
  }
  if (Date.now() >= expiresAt) throw new WalletBuyError('The quote expired. Try again.');
  signal?.throwIfAborted();
  const plan = Object.freeze({
    trades: Object.freeze(prepared.map(item => item.quote)), totalInputWei: (value * BigInt(prepared.length)).toString(),
    totalMaxFeeWei: totalMaxFeeWei.toString(), expiresAt, slippageBps,
  });
  preparedPlans.set(plan, prepared);
  return plan;
}

async function withWalletLock<T>(wallet: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return navigator.locks.request(walletTransactionLockKey(wallet), { signal }, run);
}

async function recordPendingBuys(wallet: string, pending: readonly PendingWalletBuy[]): Promise<void> {
  const key = pendingWalletBuyKey(wallet);
  if (pending.length) await browserApi.storage.local.set({ [key]: pending });
  else await browserApi.storage.local.remove(key);
}

async function broadcastBuy(raw: string, record: PendingWalletBuy): Promise<'submitted' | 'unknown' | WalletBroadcastRejection> {
  try {
    const returned = await walletRpc('eth_sendRawTransaction', [raw]);
    if (typeof returned === 'string' && returned.toLowerCase() === record.hash) return 'submitted';
  } catch (error) {
    if (error instanceof WalletBroadcastRejection) return error;
  }
  return 'unknown';
}

function assertReviewActive(expiresAt: number, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (Date.now() >= expiresAt) throw new WalletBuyError('The quote expired. Try again.');
}

async function requireReviewedNonce(wallet: string, nonce: number, hasEarlierBuys: boolean,
  expiresAt: number, signal?: AbortSignal): Promise<void> {
  const expected = BigInt(nonce);
  let current = await readQuantity('eth_getTransactionCount', [wallet, 'pending'], signal);
  // After an accepted broadcast, give the public RPC a moment to see the new nonce.
  for (let retry = 0; hasEarlierBuys && current < expected && retry < 3; retry++) {
    await new Promise(resolve => setTimeout(resolve, 300));
    assertReviewActive(expiresAt, signal);
    current = await readQuantity('eth_getTransactionCount', [wallet, 'pending'], signal);
  }
  if (current !== expected) throw new WalletBuyError('Wallet activity changed. Check Buy activity before trying the remaining orders.');
}

async function submitOneBuy(buy: PreparedBuy, signer: Wallet, pending: PendingWalletBuy[],
  expiresAt: number, signal?: AbortSignal): Promise<WalletBuyResult> {
  assertReviewActive(expiresAt, signal);
  const { quote, to, data, gasPrice, gasLimit, nonce } = buy;
  const { wallet, token, amountInWei, maxFeeWei } = quote;
  const value = BigInt(amountInWei);
  const [estimate, balance] = await Promise.all([
    estimateSwap(wallet, token, to, data, value, gasPrice, signal),
    readQuantity('eth_getBalance', [wallet, 'pending'], signal),
    requireReviewedNonce(wallet, nonce, pending.length > 0, expiresAt, signal),
  ]);
  if (estimate > gasLimit) throw new WalletBuyError('The network fee changed. Check Buy activity before trying the remaining orders.');
  if (balance < value + BigInt(maxFeeWei)) throw new WalletBuyError('Insufficient BNB for this purchase and network fee.');
  assertReviewActive(expiresAt, signal);
  const raw = await signer.signTransaction({ type: 0, chainId, to, data, value, gasPrice, gasLimit, nonce });
  assertReviewActive(expiresAt, signal);
  const record = { wallet, token, nonce, hash: keccak256(raw) };
  // Persist public fields before broadcasting so a closed popup cannot lose an ambiguous transaction.
  await recordPendingBuys(wallet, [...pending, record]);
  if (signal?.aborted || Date.now() >= expiresAt) {
    await recordPendingBuys(wallet, pending);
    assertReviewActive(expiresAt, signal);
  }
  const outcome = await broadcastBuy(raw, record);
  if (outcome === 'submitted' || outcome === 'unknown') {
    pending.push(record);
    return { wallet, token, hash: record.hash, status: outcome };
  }
  try {
    await recordPendingBuys(wallet, pending);
  } catch {
    pending.push(record);
    return { wallet, token, hash: record.hash, status: 'unknown' };
  }
  throw new WalletBuyError(outcome.reason === 'fee_rejected'
    ? 'The network rejected the fee. Try again for a new quote.'
    : 'The network rejected the purchase because the wallet has insufficient BNB.');
}

export async function submitWalletBuys(plan: WalletBuyPlan, passwords: ReadonlyMap<string, string>,
  options: { signal?: AbortSignal; onUpdate?: (result: WalletBuyResult) => void } = {}): Promise<WalletBuyResult[]> {
  const prepared = preparedPlans.get(plan);
  if (!prepared) throw new WalletBuyError('This buy request is no longer active. Start a new buy.');
  const { signal, onUpdate } = options;
  assertReviewActive(plan.expiresAt, signal);
  const byWallet = new Map<string, PreparedBuy[]>();
  for (const item of prepared) {
    const buys = byWallet.get(item.quote.wallet) ?? [];
    buys.push(item);
    byWallet.set(item.quote.wallet, buys);
  }
  preparedPlans.delete(plan);
  await requireActiveWallets([...byWallet.keys()]);
  const results: WalletBuyResult[] = [];
  const report = (result: WalletBuyResult) => {
    results.push(result);
    onUpdate?.(result);
  };

  // Unlock all the reviewed wallets before any purchase can be broadcast.
  const signers = new Map<string, Wallet>();
  for (const wallet of byWallet.keys()) {
    assertReviewActive(plan.expiresAt, signal);
    let signer: Wallet;
    try {
      signer = new Wallet(await exportLocalWallet(wallet, passwords.get(wallet)));
    } catch {
      throw new WalletBuyError(`Could not unlock ${shortAddress(wallet)}. Check the wallet password.`);
    }
    if (signer.address !== wallet) throw new WalletBuyError('A selected wallet changed.');
    signers.set(wallet, signer);
  }
  for (const [wallet, buys] of byWallet) {
    let next = 0;
    try {
      assertReviewActive(plan.expiresAt, signal);
      await withWalletLock(wallet, signal, async () => {
        await requireActiveWallets([wallet]);
        await requireNoWalletTransactions(wallet);
        await requireBnbChain(signal);
        const budget = buys.reduce((total, { quote }) => total + BigInt(quote.amountInWei) + BigInt(quote.maxFeeWei), 0n);
        if (await readQuantity('eth_getBalance', [wallet, 'pending'], signal) < budget) {
          throw new WalletBuyError('Insufficient BNB for these purchases and network fees.');
        }
        const pending: PendingWalletBuy[] = [];
        for (; next < buys.length;) {
          const result = await submitOneBuy(buys[next], signers.get(wallet)!, pending, plan.expiresAt, signal);
          next++;
          report(result);
          if (result.status === 'unknown') break;
        }
      });
      for (const { quote } of buys.slice(next)) {
        report({ wallet, token: quote.token, status: 'skipped',
          message: 'Check the uncertain purchase before submitting another from this wallet.' });
      }
    } catch (error) {
      const stopped = signal?.aborted || Date.now() >= plan.expiresAt;
      const message = signal?.aborted ? 'Purchase was not started.' : walletBuyErrorMessage(error, 'Could not submit the purchase.');
      for (const [index, { quote }] of buys.slice(next).entries()) {
        report({ wallet, token: quote.token, status: index === 0 && !stopped ? 'failed' : 'skipped', message });
      }
    }
  }
  return results;
}

async function inspectBuy(record: PendingWalletBuy, signal?: AbortSignal): Promise<WalletBuyResult['status']> {
  const receipt = await walletRpc('eth_getTransactionReceipt', [record.hash], signal);
  if (receipt !== null) {
    const { transactionHash, status } = receipt as { transactionHash?: unknown; status?: unknown };
    if (typeof transactionHash !== 'string' || transactionHash.toLowerCase() !== record.hash) {
      throw new WalletBuyError('The network returned an unexpected purchase receipt.');
    }
    const code = parseRpcQuantity(status);
    if (code === 1n) return 'confirmed';
    if (code === 0n) return 'reverted';
    throw new WalletBuyError('The network returned an invalid purchase status.');
  }
  const transaction = await walletRpc('eth_getTransactionByHash', [record.hash], signal);
  if (transaction !== null) {
    const { hash } = transaction as { hash?: unknown };
    if (typeof hash === 'string' && hash.toLowerCase() === record.hash) return 'submitted';
    throw new WalletBuyError('The network returned an unexpected transaction.');
  }
  const nonce = await readQuantity('eth_getTransactionCount', [record.wallet, 'latest'], signal);
  return nonce > BigInt(record.nonce) ? 'nonce_used' : 'unknown';
}

export async function checkPendingWalletBuys(wallet: string, signal?: AbortSignal): Promise<WalletBuyResult[]> {
  return withWalletLock(wallet, signal, async () => {
    const pending = await loadPendingWalletBuys(wallet);
    if (!pending.length) return [];
    await requireBnbChain(signal);
    const results = await inSmallBatches(pending, async record => ({ ...record, status: await inspectBuy(record, signal) }));
    const unresolved = new Set(results.filter(item => item.status === 'submitted' || item.status === 'unknown').map(item => item.hash));
    await recordPendingBuys(wallet, pending.filter(record => unresolved.has(record.hash)));
    return results;
  });
}
