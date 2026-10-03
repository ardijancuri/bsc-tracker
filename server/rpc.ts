let requestId = 0;
export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
export const chainRpc: Rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  const response = await fetch(process.env.BSC_RPC_HTTP || 'http://127.0.0.1:8545', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RPC ${method} returned ${response.status}`);
  const body = await response.json() as { result?: T; error?: { message: string } };
  if (body.error || body.result == null) throw new Error(`RPC ${method} unavailable`);
  return body.result;
};
export const blockHex = (block: number | string) => `0x${BigInt(block).toString(16)}`;
