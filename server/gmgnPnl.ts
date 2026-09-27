import { randomUUID } from 'node:crypto';

export type GmgnProfit = {
  walletAddress: string;
  period: '1d' | '7d' | '30d';
  realizedProfitUsd: string | null;
  unrealizedProfitUsd: string | null;
};

const walletRe = /^0x[a-fA-F0-9]{40}$/;
const decimalRe = /^-?(?:\d+)(?:\.\d+)?$/;

function decimal(value: unknown): string | null {
  if (value == null || value === '') return null;
  const result = String(value);
  if (!decimalRe.test(result)) throw new Error('GMGN returned an invalid profit value');
  return result;
}

export function parseGmgnProfits(payload: unknown, wallets: string[], period: GmgnProfit['period']): GmgnProfit[] {
  const body = payload as { list?: unknown[]; data?: { list?: unknown[] } };
  const list = body?.list ?? body?.data?.list;
  if (!Array.isArray(list)) throw new Error('GMGN profit response has no list');
  const expected = new Set(wallets.map(wallet => wallet.toLowerCase()));
  const results = new Map<string, GmgnProfit>();
  for (const raw of list) {
    const row = raw as Record<string, unknown>;
    const wallet = row?.wallet_address;
    if (typeof wallet !== 'string' || !walletRe.test(wallet) || !expected.has(wallet.toLowerCase())) continue;
    results.set(wallet.toLowerCase(), {
      walletAddress: wallet.toLowerCase(), period,
      realizedProfitUsd: decimal(row.realized_profit),
      unrealizedProfitUsd: decimal(row.unrealized_profit),
    });
  }
  return wallets.map(wallet => results.get(wallet.toLowerCase()) ?? {
    walletAddress: wallet.toLowerCase(), period, realizedProfitUsd: null, unrealizedProfitUsd: null,
  });
}

export async function fetchGmgnProfits(wallets: string[], period: GmgnProfit['period'], apiKey: string): Promise<GmgnProfit[]> {
  const url = new URL('https://openapi.gmgn.ai/v1/user/wallet_profits');
  url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  url.searchParams.set('client_id', randomUUID());
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'X-APIKEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'bsc', period, wallet_addresses: wallets }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GMGN profit request failed: HTTP ${response.status}`);
  const envelope = await response.json() as { code?: number; data?: unknown };
  if (envelope.code !== 0) throw new Error(`GMGN profit request failed: code ${envelope.code ?? 'unknown'}`);
  return parseGmgnProfits(envelope.data, wallets, period);
}
