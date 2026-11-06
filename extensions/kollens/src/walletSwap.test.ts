import { Interface, Transaction, Wallet, keccak256, parseEther, toQuantity } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletBroadcastRejection } from './walletRpc';
import {
  checkPendingWalletBuys, loadPendingWalletBuys, previewWalletBuys, submitWalletBuys,
} from './walletSwap';
import { previewWalletTransfer } from './walletTransfer';

const mocked = vi.hoisted(() => ({
  rpc: vi.fn(), list: vi.fn(), unlock: vi.fn(), launchpad: vi.fn(),
  get: vi.fn(), set: vi.fn(), remove: vi.fn(),
}));
vi.mock('./walletRpc', async importOriginal => ({
  ...await importOriginal<typeof import('./walletRpc')>(), walletRpc: mocked.rpc,
}));
vi.mock('./walletVault', () => ({ listLocalWallets: mocked.list, exportLocalWallet: mocked.unlock }));
vi.mock('./walletBuyLaunchpads', () => ({ quoteLaunchpadBuy: mocked.launchpad }));
vi.mock('./platform', () => ({
  browserApi: { storage: { local: { get: mocked.get, set: mocked.set, remove: mocked.remove } } },
}));

// Synthetic test signers, never connected to a network.
const signerA = new Wallet('0x' + '31'.repeat(32));
const signerB = new Wallet('0x' + '32'.repeat(32));
const tokenA = '0x' + '12'.repeat(20);
const tokenB = '0x' + '13'.repeat(20);
const router = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const wrappedBnb = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const abi = new Interface([
  'function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 minOut,address[] path,address recipient,uint256 deadline) payable',
]);
const amount = parseEther('0.05');
const output = 4_000_000n;
const gasPrice = 3_000_000_000n;
const gasEstimate = 100_000n;
const fee = gasPrice * 120_000n;
const passwords = new Map([[signerB.address, 'local-demo-password']]);
const storage = new Map<string, unknown>();
const nonces = new Map<string, bigint>();
const receipts = new Map<string, {transactionHash: string; status: string}>();
const broadcasts: Transaction[] = [];
let balance = parseEther('1');
let outcome: 'accepted' | 'unknown' | 'rejected';
let rejectToken: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  storage.clear();
  nonces.clear();
  receipts.clear();
  broadcasts.length = 0;
  balance = parseEther('1');
  outcome = 'accepted';
  rejectToken = undefined;
  vi.stubGlobal('navigator', { locks: {
    request: (_key: string, options: unknown, run?: () => Promise<unknown>) =>
      (typeof options === 'function' ? options : run!)(),
  } });
  mocked.get.mockImplementation(async key => ({ [key]: storage.get(key) }));
  mocked.set.mockImplementation(async patch => {
    for (const [key, value] of Object.entries(patch)) storage.set(key, structuredClone(value));
  });
  mocked.remove.mockImplementation(async key => { storage.delete(key); });
  mocked.list.mockResolvedValue([
    { address: signerA.address, archived: false, protection: 'device' },
    { address: signerB.address, archived: false, protection: 'password' },
  ]);
  mocked.unlock.mockImplementation(async (wallet, password) => {
    if (wallet === signerA.address) return signerA.privateKey;
    if (wallet === signerB.address && password === passwords.get(wallet)) return signerB.privateKey;
    throw new Error('Invalid password');
  });
  mocked.launchpad.mockResolvedValue(null);
  mocked.rpc.mockImplementation(async (method: string, params: any[]) => {
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_getBalance') return toQuantity(balance);
    if (method === 'eth_gasPrice') return toQuantity(gasPrice);
    if (method === 'eth_getTransactionCount') return toQuantity(nonces.get(params[0]) ?? 4n);
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (data === '0x313ce567') return '0x' + '6'.padStart(64, '0');
      expect(to).toBe(router);
      const [input, path] = abi.decodeFunctionData('getAmountsOut', data);
      expect(input).toBe(amount);
      expect(path[0]).toBe(wrappedBnb);
      return abi.encodeFunctionResult('getAmountsOut', [[input, output]]);
    }
    if (method === 'eth_estimateGas') {
      if (rejectToken && params[0].data && abi.parseTransaction({data:params[0].data})?.args[1][1] === rejectToken) {
        throw new Error('Slippage reverted');
      }
      return toQuantity(params[0].data ? gasEstimate : 21_000n);
    }
    if (method === 'eth_sendRawTransaction') {
      const raw = params[0];
      const transaction = Transaction.from(raw);
      const records = await loadPendingWalletBuys(transaction.from!);
      expect(records.at(-1)?.hash).toBe(keccak256(raw));
      broadcasts.push(transaction);
      if (outcome === 'unknown') throw new Error('RPC timeout after submission');
      if (outcome === 'rejected') throw new WalletBroadcastRejection('fee_rejected');
      nonces.set(transaction.from!, BigInt(transaction.nonce + 1));
      return keccak256(raw);
    }
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0]) ?? null;
    if (method === 'eth_getTransactionByHash') return null;
    throw new Error(`Unexpected RPC method ${method}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reviewed native BNB purchases', () => {
  it('deduplicates the group and uses reviewed recipients, limits, exact native value and wallet nonces', async () => {
    const plan = await previewWalletBuys(
      [signerA.address, signerB.address, signerA.address], [tokenA, tokenB, tokenA], '0.05', 100,
    );
    expect(plan.totalInputWei).toBe((4n * amount).toString());
    expect(plan.totalMaxFeeWei).toBe((4n * fee).toString());
    expect(plan.trades).toHaveLength(4);
    expect(plan.trades[0]).toMatchObject({
      wallet: signerA.address, token: tokenA, provider: 'PancakeSwap V2', decimals: 6,
      quotedOut: output.toString(), minimumOut: '3960000', maxFeeWei: fee.toString(),
    });
    expect(broadcasts).toHaveLength(0);

    const results = await submitWalletBuys(plan, passwords);
    expect(results.map(item => item.status)).toEqual(['submitted', 'submitted', 'submitted', 'submitted']);
    expect(broadcasts.map(transaction => transaction.nonce)).toEqual([4, 5, 4, 5]);
    for (const [index, transaction] of broadcasts.entries()) {
      const reviewed = plan.trades[index];
      expect(transaction).toMatchObject({
        from: reviewed.wallet, to: router, chainId: 56n, value: amount, gasPrice, gasLimit: 120_000n,
      });
      const decoded = abi.parseTransaction({ data: transaction.data });
      expect(decoded?.name).toBe('swapExactETHForTokensSupportingFeeOnTransferTokens');
      expect(decoded?.args[0]).toBe(3_960_000n);
      expect([...decoded!.args[1]]).toEqual([wrappedBnb, reviewed.token]);
      expect(decoded?.args[2]).toBe(reviewed.wallet);
      expect(decoded?.args[3]).toBe(BigInt(Math.floor(plan.expiresAt / 1000) + 30));
    }
    await expect(submitWalletBuys(plan, passwords)).rejects.toThrow('This buy request is no longer active');
  });

  it('blocks a group if a wallet cannot cover every reviewed amount and fee', async () => {
    balance = 2n * amount + fee;
    await expect(previewWalletBuys([signerA.address], [tokenA, tokenB], '0.05', 100)).rejects.toThrow('network fees');
    expect(broadcasts).toHaveLength(0);
    expect(mocked.unlock).not.toHaveBeenCalled();
  });

  it('unlocks all reviewed wallets before broadcasting any purchase', async () => {
    const plan = await previewWalletBuys([signerA.address, signerB.address], [tokenA], '0.05', 100);
    await expect(submitWalletBuys(plan, new Map())).rejects.toThrow('Could not unlock');
    expect(broadcasts).toHaveLength(0);
  });

  it('does not execute a stale or forged plan', async () => {
    const plan = await previewWalletBuys([signerA.address], [tokenA], '0.05', 100);
    await expect(submitWalletBuys({...plan}, passwords)).rejects.toThrow('This buy request is no longer active');
    vi.spyOn(Date, 'now').mockReturnValue(plan.expiresAt);
    await expect(submitWalletBuys(plan, passwords)).rejects.toThrow('quote expired');
    expect(broadcasts).toHaveLength(0);
  });

  it('holds an ambiguous broadcast by hash, skips the next buy, and protects native Send until reconciliation', async () => {
    const plan = await previewWalletBuys([signerA.address], [tokenA, tokenB], '0.05', 100);
    outcome = 'unknown';
    const results = await submitWalletBuys(plan, passwords);
    expect(results.map(item => item.status)).toEqual(['unknown', 'skipped']);
    expect(broadcasts).toHaveLength(1);
    expect(await checkPendingWalletBuys(signerA.address)).toMatchObject([{status:'unknown', hash:results[0].hash}]);
    await expect(previewWalletTransfer(signerA.address, signerB.address, '0.01')).rejects.toThrow('Check pending token purchases');

    const hash = results[0].hash!;
    receipts.set(hash, { transactionHash: hash, status: '0x1' });
    expect(await checkPendingWalletBuys(signerA.address)).toMatchObject([{status:'confirmed', hash}]);
    expect(await loadPendingWalletBuys(signerA.address)).toEqual([]);
    await expect(previewWalletTransfer(signerA.address, signerB.address, '0.01')).resolves.toBeDefined();
  });

  it('records a failed second simulation and skips any subsequent purchase for its wallet', async () => {
    const tokenC = '0x' + '14'.repeat(20);
    const plan = await previewWalletBuys([signerA.address], [tokenA, tokenB, tokenC], '0.05', 100);
    rejectToken = tokenB;
    const results = await submitWalletBuys(plan, passwords);
    expect(results.map(item => item.status)).toEqual(['submitted', 'failed', 'skipped']);
    expect(broadcasts).toHaveLength(1);
  });

  it('clears a definite pre-admission rejection and keeps the rest unstarted on abort', async () => {
    const plan = await previewWalletBuys([signerA.address], [tokenA, tokenB], '0.05', 100);
    outcome = 'rejected';
    expect((await submitWalletBuys(plan, passwords)).map(item => item.status)).toEqual(['failed', 'skipped']);
    expect(await loadPendingWalletBuys(signerA.address)).toEqual([]);

    outcome = 'accepted';
    const next = await previewWalletBuys([signerA.address], [tokenA, tokenB], '0.05', 100);
    const abort = new AbortController();
    const results = await submitWalletBuys(next, passwords, {
      signal: abort.signal, onUpdate: result => { if (result.status === 'submitted') abort.abort(); },
    });
    expect(results.map(item => item.status)).toEqual(['submitted', 'skipped']);
    expect(await loadPendingWalletBuys(signerA.address)).toHaveLength(1);
  });

  it('prioritizes a verified bonding curve over a V2 pair', async () => {
    const portal = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';
    mocked.launchpad.mockResolvedValue({
      kind: 'flap', estimatedOutput: 9_000_000n,
      buildData: () => ({to:portal, value:amount, data:'0x12345678'}),
    });
    const plan = await previewWalletBuys([signerA.address], [tokenA], '0.05', 100);
    expect(plan.trades[0]).toMatchObject({provider:'Flap', quotedOut:'9000000'});
    expect(mocked.launchpad).toHaveBeenCalledWith(expect.objectContaining({token:tokenA, wallet:signerA.address, value:amount}));
  });
});
