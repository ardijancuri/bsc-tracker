export const walletRpcUrl = 'https://bsc-dataseed.bnbchain.org';
export const walletRpcPermission = { origins: [`${walletRpcUrl}/*`] };

export class WalletBroadcastRejection extends Error {
  constructor(readonly reason: 'fee_rejected' | 'balance_rejected') {
    super('BNB Chain rejected the transaction.');
  }
}

function broadcastRejection(error: unknown): WalletBroadcastRejection | null {
  if (!error || typeof error !== 'object') return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== -32000 || typeof message !== 'string' || message.length > 400 || message.trim() !== message) return null;
  // BNB's Geth transaction pool rejects these before admitting the transaction.
  if (message === 'transaction underpriced' || message === 'replacement transaction underpriced'
    || /^transaction gas price below minimum(?:: gas tip cap \d{1,78}, minimum needed \d{1,78})?$/.test(message)) {
    return new WalletBroadcastRejection('fee_rejected');
  }
  const funds = /^insufficient funds for gas \* price \+ value(?:: balance \d{1,78}, (?:tx cost \d{1,78}|queued cost \d{1,78}, (?:tx cost \d{1,78}|tx bumped -?\d{1,78})), overshot \d{1,78})?$/;
  if (funds.test(message)) {
    return new WalletBroadcastRejection('balance_rejected');
  }
  return null;
}

export async function walletRpc(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch(walletRpcUrl, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error('BNB Chain RPC unavailable.');
  const body = await response.json();
  if (body?.jsonrpc !== '2.0' || body.id !== 1) throw new Error('Invalid BNB Chain RPC response.');
  const hasResult = Object.hasOwn(body, 'result');
  if (Object.hasOwn(body, 'error')) {
    if (method === 'eth_sendRawTransaction' && !hasResult) {
      const rejection = broadcastRejection(body.error);
      if (rejection) throw rejection;
    }
    throw new Error('BNB Chain RPC request failed.');
  }
  if (!hasResult) throw new Error('Invalid BNB Chain RPC response.');
  return body.result;
}

export function parseRpcQuantity(result: unknown): bigint {
  if (typeof result !== 'string' || !/^0x[\da-f]{1,64}$/i.test(result)) {
    throw new Error('Invalid BNB Chain RPC quantity.');
  }
  return BigInt(result);
}
