export function shortAddress(value: string, size = 5) {
  return value ? `${value.slice(0, size + 2)}…${value.slice(-4)}` : '—';
}

export function compact(value: string | number | null | undefined, currency = false) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs < 0.01 && abs > 0 ? 6 : abs < 1 ? 4 : abs < 100 ? 2 : 1;
  const formatted = new Intl.NumberFormat('en-US', {
    notation: abs >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: digits,
  }).format(n);
  return currency ? `$${formatted}` : formatted;
}

export function signedMoney(value: string | null | undefined) {
  if (value == null) return '—';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${compact(value, true)}`;
}

export function relativeTime(value: string | null | undefined) {
  if (!value) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export async function api<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
