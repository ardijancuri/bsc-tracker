import { stockTokenAddresses } from './stockTokenAddresses.js';

const stocks = new Set<string>(stockTokenAddresses);
const addressesSql = stockTokenAddresses.map(address => `'${address}'`).join(',');

export function isStockToken(address: string): boolean {
  return stocks.has(address.toLowerCase());
}

// Apply before LIMIT/aggregation so pagination and activity totals describe visible trades.
export function nonStockTokenSql(addressColumn = 'v.address'): string {
  return `(lower(${addressColumn}) NOT IN (${addressesSql}))`;
}
