import { Transaction, Wallet, parseEther } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWalletTransfer, loadPendingWalletTransfer, previewWalletTransfer, submitWalletTransfer } from './walletTransfer';
import { walletRpcUrl } from './walletRpc';
import { exportLocalWallet } from './walletVault';

const storage = vi.hoisted(() => new Map<string, unknown>());
const removeRecord = vi.hoisted(() => vi.fn(async (key: string) => { storage.delete(key); }));
vi.mock('./platform', () => ({
  browserApi: { storage: { local: {
    get: async (key: string) => ({ [key]: storage.get(key) }),
    set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) storage.set(key, value); },
    remove: removeRecord,
  } } },
}));
vi.mock('./walletVault', () => ({ exportLocalWallet: vi.fn() }));

const testKey = '0x' + '1'.padStart(64, '0');
const from = new Wallet(testKey).address;
const to = '0x0000000000000000000000000000000000000002';

describe('BNB wallet transfer', () => {
  let nonce: number;
  let chain: string;
  let rpcBalance: string;
  let responseLost: boolean;
  let rejection: { code: number; message: string } | null;
  let httpStatus: number;
  let mixedResponse: boolean;
  let signedTransactions: string[];
  let receipt: unknown;

  beforeEach(() => {
    storage.clear();
    nonce = 7;
    chain = '0x38';
    rpcBalance = '0xde0b6b3a7640000';
    responseLost = false;
    rejection = null;
    httpStatus = 200;
    mixedResponse = false;
    signedTransactions = [];
    receipt = null;
    let lock = Promise.resolve();
    vi.stubGlobal('navigator', { locks: { request<T>(_key: string, action: () => Promise<T>) {
      const next = lock.then(action);
      lock = next.then(() => undefined, () => undefined);
      return next;
    } } });
    vi.mocked(exportLocalWallet).mockResolvedValue(testKey);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(walletRpcUrl);
      const { id, method, params } = JSON.parse(String(init?.body));
      const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
      switch (method) {
        case 'eth_chainId': return respond(chain);
        case 'eth_getBalance': return respond(rpcBalance);
        case 'eth_getTransactionCount': return respond('0x' + nonce.toString(16));
        case 'eth_gasPrice': return respond('0x5f5e100');
        case 'eth_estimateGas': return respond('0x5208');
        case 'eth_getTransactionReceipt': return respond(receipt);
        case 'eth_getTransactionByHash': return respond(null);
        case 'eth_sendRawTransaction': {
          const raw = String(params[0]);
          const hash = Transaction.from(raw).hash;
          expect([...storage.values()]).toEqual([expect.objectContaining({ hash })]);
          signedTransactions.push(raw);
          if (responseLost) throw new Error('Mock lost RPC response');
          if (rejection) {
            const error = { jsonrpc: '2.0', id, error: rejection };
            return Response.json(mixedResponse ? { ...error, result: hash } : error, { status: httpStatus });
          }
          return respond(hash);
        }
        default: throw new Error(`Unexpected mock method ${method}`);
      }
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('signs the exact reviewed transfer locally and prevents concurrent duplicate sends', async () => {
    const preview = await previewWalletTransfer(from, to, '0.123456789012345678');
    expect(exportLocalWallet).not.toHaveBeenCalled();
    const [first, duplicate] = await Promise.allSettled([
      submitWalletTransfer(preview), submitWalletTransfer(preview),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(duplicate.status).toBe('rejected');
    expect(signedTransactions).toHaveLength(1);
    const tx = Transaction.from(signedTransactions[0]);
    expect(tx).toMatchObject({
      chainId: 56n, from, to, nonce: 7, value: parseEther('0.123456789012345678'),
      gasLimit: 21_000n, gasPrice: 100_000_000n,
    });
  });

  it('retries the same signed transaction after a lost response and clears a confirmed submission', async () => {
    responseLost = true;
    const result = await submitWalletTransfer(await previewWalletTransfer(from, to, '0.2'), 'wallet password');
    expect(result.status).toBe('unknown');
    expect(JSON.stringify([...storage.values()])).not.toContain(testKey);
    expect(JSON.stringify([...storage.values()])).not.toContain(signedTransactions[0]);
    const reopened = await loadPendingWalletTransfer(from);
    expect(reopened).toEqual(result.transfer);
    expect(await checkWalletTransfer(result.transfer)).toBe('unknown');
    responseLost = false;
    expect(await checkWalletTransfer(result.transfer, { password: 'wallet password' })).toBe('pending');
    expect(signedTransactions).toEqual([signedTransactions[0], signedTransactions[0]]);
    expect(exportLocalWallet).toHaveBeenLastCalledWith(from, 'wallet password');
    receipt = { transactionHash: result.transfer.hash, status: '0x1' };
    expect(await checkWalletTransfer(result.transfer)).toBe('confirmed');
    expect(await loadPendingWalletTransfer(from)).toBeNull();
  });

  it('rejects a changed nonce, wrong chain, bad amount and insufficient funds without signing', async () => {
    await expect(previewWalletTransfer(from, to, '1e-3')).rejects.toThrow(/decimal/);
    chain = '0x1';
    await expect(previewWalletTransfer(from, to, '0.2')).rejects.toThrow(/different network/);
    chain = '0x38';
    await expect(previewWalletTransfer(from, to, '1')).rejects.toThrow(/insufficient BNB/);
    const preview = await previewWalletTransfer(from, to, '0.2');
    nonce += 1;
    await expect(submitWalletTransfer(preview)).rejects.toThrow(/activity changed/);
    expect(exportLocalWallet).not.toHaveBeenCalled();
    expect(signedTransactions).toHaveLength(0);
  });

  it.each([
    ['transaction underpriced', /network rejected the fee/],
    ['replacement transaction underpriced', /network rejected the fee/],
    ['transaction gas price below minimum: gas tip cap 100, minimum needed 200', /network rejected the fee/],
    ['insufficient funds for gas * price + value: balance 1, tx cost 2, overshot 1', /insufficient BNB/],
  ])('clears a definitively rejected first broadcast (%s)', async (message, expectedError) => {
    rejection = { code: -32000, message };
    const preview = await previewWalletTransfer(from, to, '0.2');
    await expect(submitWalletTransfer(preview)).rejects.toThrow(expectedError);
    expect(signedTransactions).toHaveLength(1);
    expect(await loadPendingWalletTransfer(from)).toBeNull();
    await expect(previewWalletTransfer(from, to, '0.2')).resolves.toMatchObject({ nonce });
  });

  it.each([
    [-32000, 'already known', 200, false],
    [-32000, 'transaction underpriced\n', 200, false],
    [-32000, 'transaction underpriced', 503, false],
    [-32000, 'transaction underpriced', 200, true],
    [-32003, 'transaction underpriced', 200, false],
  ])('keeps pending state for ambiguous responses (%d, %s, HTTP %d, mixed %s)', async (code, message, status, mixed) => {
    rejection = { code, message };
    httpStatus = status;
    mixedResponse = mixed;
    const result = await submitWalletTransfer(await previewWalletTransfer(from, to, '0.2'));
    expect(result.status).toBe('unknown');
    expect(await loadPendingWalletTransfer(from)).toEqual(result.transfer);
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('retains the journal when a retry is rejected after a lost first response', async () => {
    responseLost = true;
    const result = await submitWalletTransfer(await previewWalletTransfer(from, to, '0.2'));
    responseLost = false;
    rejection = { code: -32000, message: 'transaction underpriced' };
    expect(await checkWalletTransfer(result.transfer, {})).toBe('unknown');
    expect(await loadPendingWalletTransfer(from)).toEqual(result.transfer);
    expect(signedTransactions).toEqual([signedTransactions[0], signedTransactions[0]]);
    expect(removeRecord).not.toHaveBeenCalled();
  });

  it('preserves the record if removal cannot be confirmed', async () => {
    rejection = { code: -32000, message: 'transaction underpriced' };
    removeRecord.mockImplementationOnce(async key => {
      storage.delete(key);
      throw new Error('Mock storage acknowledgement lost');
    });
    const result = await submitWalletTransfer(await previewWalletTransfer(from, to, '0.2'));
    expect(result.status).toBe('unknown');
    expect(await loadPendingWalletTransfer(from)).toEqual(result.transfer);
  });
});
