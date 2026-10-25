import { pool } from './db.js';
import { createGmgnRequester as createRequester, reserveGmgnSlot as reserveSlot, type GmgnBudgetQuery } from './gmgnTransport.js';
export * from './gmgnTransport.js';
const defaultQuery: GmgnBudgetQuery = (sql, values) => pool.query(sql, values);
/** Legacy callers retain their existing database adapter; fresh runtime injects its own. */
export function createGmgnRequester(options: Omit<Parameters<typeof createRequester>[0], 'query'> & { query?: GmgnBudgetQuery } = {}) {
  return createRequester({ ...options, query: options.query ?? defaultQuery });
}
export function reserveGmgnSlot(apiKey: string, weight: 1 | 2 | 3 | 5, priority: import('./providerPriority.js').GeckoPriority, query: GmgnBudgetQuery = defaultQuery) {
  return reserveSlot(apiKey, weight, priority, query);
}
export const gmgnRequest = createGmgnRequester();
