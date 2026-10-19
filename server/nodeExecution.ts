import { beforeExecutionTopic, userOperationTopic } from './smartAccountTrades.js';
import { transferTopic } from './swap.js';
import { ensureNodeTraceSchema, queueNodeTraceExecutions } from './nodeTrace.js';

export const NODE_EXECUTION_VERSION = 1;
export const NODE_ENTRY_POINTS = ['0x0000000071727de22e5e9d8baf0edac6f37da032'];
export type NodeLog = { address: string; topics: string[]; data: string; logIndex?: string; transactionHash?: string; blockNumber?: string; blockHash?: string; removed?: boolean };
export type NodeTransaction = { hash: string; from: string; to: string | null; value: string; blockNumber: string; blockHash?: string; transactionIndex: string | null; gasPrice?: string; [key: string]: unknown };
export type NodeReceipt = { status: string; logs: NodeLog[]; blockHash: string; transactionHash?: string; blockNumber?: string; transactionIndex?: string; gasUsed?: string; effectiveGasPrice?: string; [key: string]: unknown };
export type NodeBlock = { number: string; hash: string; parentHash: string; timestamp: string; transactions?: NodeTransaction[]; [key: string]: unknown };
export type NodeExecution = { id: string; txHash: string; walletAddress: string; executionIndex: number; operationHash: string | null;
  blockNumber: number; blockHash: string; transactionIndex: number; timestamp: number; status: 'success' | 'failed' | 'unsupported';
  kind: 'transaction' | 'user_operation' | 'transfer'; feeNativeWei: string | null; feeComplete: boolean; feeReason: string | null;
  nativeValueRaw: string; transactionTo?:string|null; logs: NodeLog[]; flows: { tokenAddress: string; deltaRaw: string; logIndices: number[]; counterparties: string[] }[] };
const addr = (raw: unknown) => typeof raw === 'string' && /^0x[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : null;
const topicAddr = (raw: unknown) => typeof raw === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(raw) ? `0x${raw.slice(-40)}`.toLowerCase() : null;
const integer = (raw: unknown) => typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw) && raw.length <= 66 ? BigInt(raw) : null;
const zero = `0x${'0'.repeat(40)}`;

/** Raw flow identity is independent of token metadata, prices and display
 * exclusions. A token is never assigned guessed decimals during collection. */
export function executionTokenFlows(wallet: string, logs: NodeLog[]) {
  const result = new Map<string, { tokenAddress: string; delta: bigint; logIndices: number[]; counterparties: Set<string> }>();
  for (const log of logs) {
    const from = topicAddr(log.topics[1]), to = topicAddr(log.topics[2]), tokenAddress = addr(log.address), value = integer(log.data);
    if (log.removed || log.topics[0]?.toLowerCase() !== transferTopic || log.topics.length !== 3 || !tokenAddress || value == null || !from || !to || from === to || from !== wallet && to !== wallet) continue;
    if (!/^0x[0-9a-f]+$/i.test(log.logIndex ?? '')) throw new Error('execution_log_position_missing');
    const position = Number(BigInt(log.logIndex!));
    if (!Number.isSafeInteger(position)) throw new Error('execution_log_position_invalid');
    const entry = result.get(tokenAddress) ?? { tokenAddress, delta: 0n, logIndices: [], counterparties: new Set<string>() };
    entry.delta += value * (from === wallet ? -1n : 1n); entry.logIndices.push(position); entry.counterparties.add(from === wallet ? to : from); result.set(tokenAddress, entry);
  }
  return [...result.values()].filter(item => item.delta !== 0n).map(item => ({ tokenAddress: item.tokenAddress, deltaRaw: item.delta.toString(), logIndices: item.logIndices, counterparties: [...item.counterparties] }));
}

/** Execution boundaries use the authenticated EntryPoint event position, not
 * sender uniqueness. Multiple operations by one sender stay separate. */
export function decodeNodeExecutions(tx: NodeTransaction, receipt: NodeReceipt, block: NodeBlock, wallets: Set<string>): NodeExecution[] {
  const from = addr(tx.from), to = addr(tx.to), hash = tx.hash.toLowerCase(), blockNumber = Number(BigInt(block.number));
  if (!from || !/^0x[0-9a-f]{64}$/.test(hash) || !['0x0', '0x1'].includes(receipt.status) || receipt.logs.some(log => log.removed)) throw new Error('execution_evidence_invalid');
  if (tx.transactionIndex == null || !Number.isSafeInteger(Number(BigInt(tx.transactionIndex)))) throw new Error('execution_transaction_position_missing');
  const result: NodeExecution[] = [], usedLogs = new Map<string, Set<NodeLog>>();
  const make = (wallet: string, kind: NodeExecution['kind'], logs: NodeLog[], options: Partial<NodeExecution> = {}) => {
    const index = result.filter(item => item.walletAddress === wallet).length;
    const entry: NodeExecution = { id: `${hash}:${wallet}:${options.operationHash ?? kind}:${options.operationHash ? '' : index}`,
      txHash: hash, walletAddress: wallet, executionIndex: index, operationHash: null, blockNumber, blockHash: block.hash.toLowerCase(), transactionIndex: Number(BigInt(tx.transactionIndex!)),
      timestamp: Number(BigInt(block.timestamp)), status: receipt.status === '0x1' ? 'success' : 'failed', kind,
      feeNativeWei: '0', feeComplete: true, feeReason: null, nativeValueRaw: '0', transactionTo:to, logs, flows: executionTokenFlows(wallet, logs), ...options };
    result.push(entry); const used = usedLogs.get(wallet) ?? new Set<NodeLog>(); logs.forEach(log => used.add(log)); usedLogs.set(wallet, used); return entry;
  };
  if (wallets.has(from)) {
    const gas = integer(receipt.gasUsed), price = integer(receipt.effectiveGasPrice ?? tx.gasPrice), value = integer(tx.value);
    make(from, 'transaction', receipt.status === '0x1' && (!to || !NODE_ENTRY_POINTS.includes(to)) ? receipt.logs : [], { feeNativeWei: gas != null && price != null ? (gas * price).toString() : null,
      feeComplete: gas != null && price != null, feeReason: gas != null && price != null ? null : 'transaction_fee_unavailable', nativeValueRaw: receipt.status === '0x1' && value != null ? value.toString() : '0' });
  }
  if (to && NODE_ENTRY_POINTS.includes(to) && receipt.status === '0x1') {
    const markers = receipt.logs.map((log, index) => ({ log, index })).filter(item => addr(item.log.address) === to && item.log.topics[0]?.toLowerCase() === beforeExecutionTopic);
    const validBoundary = markers.length === 1 && markers[0].log.topics.length === 1 && markers[0].log.data === '0x';
    let start = validBoundary ? markers[0].index + 1 : 0;
    const operations = new Set<string>();
    for (let index = start; index < receipt.logs.length; index++) {
      const log = receipt.logs[index];
      if (addr(log.address) !== to || log.topics[0]?.toLowerCase() !== userOperationTopic) continue;
      const sender = topicAddr(log.topics[2]), paymaster = topicAddr(log.topics[3]), operation = log.topics[1]?.toLowerCase();
      const valid = log.topics.length === 4 && /^0x[0-9a-f]{64}$/i.test(operation ?? '') && /^0x[0-9a-f]{256}$/i.test(log.data) && sender && sender !== zero && paymaster;
      if (!valid) throw new Error('operation_evidence_invalid');
      if (operations.has(operation!)) throw new Error('operation_identity_duplicate'); operations.add(operation!);
      const words = log.data.slice(2).match(/.{64}/g)!; const success = BigInt(`0x${words[1]}`);
      if (success > 1n) throw new Error('operation_success_invalid');
      if (wallets.has(sender!)) {
        const supported = validBoundary && paymaster === zero;
        make(sender!, 'user_operation', supported && success === 1n ? receipt.logs.slice(start, index) : [], { operationHash: operation!,
          status: supported ? success === 1n ? 'success' : 'failed' : 'unsupported',
          feeNativeWei: paymaster === zero ? BigInt(`0x${words[2]}`).toString() : null,
          feeComplete: supported, feeReason: supported ? null : !validBoundary ? 'operation_boundary_unavailable' : 'sponsored_operation_fee_unknown' });
      }
      start = index + 1;
    }
  }
  // A recipient is not charged the sender's gas. Preserve wallet transfers that
  // happened outside an authenticated operation rather than folding them in.
  if (receipt.status === '0x1') for (const wallet of wallets) {
    const remaining = receipt.logs.filter(log => !usedLogs.get(wallet)?.has(log));
    if (executionTokenFlows(wallet, remaining).length) make(wallet, 'transfer', remaining);
    if (to === wallet && from !== wallet && integer(tx.value)! > 0n) make(wallet, 'transfer', [], { nativeValueRaw: `-${integer(tx.value)!.toString()}` });
  }
  return result;
}

export async function ensureNodeExecutionSchema(database: { query: (sql: string, values?: any[]) => Promise<any> }) {
  await database.query(`CREATE TABLE IF NOT EXISTS node_executions(
    id text PRIMARY KEY,tx_hash text NOT NULL REFERENCES node_evidence_transactions(tx_hash) ON DELETE CASCADE,wallet_address text NOT NULL,
    execution_index integer NOT NULL,operation_hash text,block_number bigint NOT NULL,block_hash text NOT NULL,transaction_index integer NOT NULL,
    timestamp timestamptz NOT NULL,status text NOT NULL,kind text NOT NULL,fee_native_wei numeric,fee_complete boolean NOT NULL,fee_reason text,native_value_raw numeric NOT NULL,
    logs jsonb NOT NULL,decoder_version integer NOT NULL,UNIQUE(tx_hash,wallet_address,execution_index));
    CREATE INDEX IF NOT EXISTS node_executions_wallet_time ON node_executions(wallet_address,block_number,transaction_index,execution_index);
    CREATE TABLE IF NOT EXISTS node_execution_flows(execution_id text NOT NULL REFERENCES node_executions(id) ON DELETE CASCADE,
      token_address text NOT NULL,delta_raw numeric NOT NULL,log_indices integer[] NOT NULL,counterparties text[] NOT NULL,PRIMARY KEY(execution_id,token_address));
    CREATE INDEX IF NOT EXISTS node_execution_flows_token ON node_execution_flows(token_address,execution_id);`);
  // Existing trade IDs remain unchanged: notification/replay references keep
  // their identity. Only execution-aware projections use the additional key.
  await database.query(`DO $migration$ DECLARE constraint_name text; BEGIN
    IF to_regclass('trades') IS NOT NULL THEN
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS execution_id text;
      FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='trades'::regclass AND contype='u'
        AND pg_get_constraintdef(oid)='UNIQUE (tx_hash, wallet_address, token_address)'
      LOOP EXECUTE format('ALTER TABLE trades DROP CONSTRAINT %I',constraint_name); END LOOP;
      CREATE UNIQUE INDEX IF NOT EXISTS trades_legacy_identity ON trades(tx_hash,wallet_address,token_address) WHERE execution_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS trades_execution_identity ON trades(execution_id,token_address) WHERE execution_id IS NOT NULL;
    END IF; END $migration$;`);
  await ensureNodeTraceSchema(database);
}

export async function persistNodeExecutions(database: { query: (sql: string, values?: any[]) => Promise<any> }, executions: NodeExecution[]) {
  const tokens = [...new Set(executions.flatMap(entry => entry.flows.map(flow => flow.tokenAddress)))];
  if (tokens.length) await database.query('INSERT INTO tokens(address) SELECT unnest($1::text[]) ON CONFLICT(address) DO NOTHING', [tokens]);
  for (const entry of executions) {
    await database.query(`INSERT INTO node_executions(id,tx_hash,wallet_address,execution_index,operation_hash,block_number,block_hash,transaction_index,timestamp,status,kind,
      fee_native_wei,fee_complete,fee_reason,native_value_raw,logs,decoder_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
      ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,fee_native_wei=EXCLUDED.fee_native_wei,fee_complete=EXCLUDED.fee_complete,fee_reason=EXCLUDED.fee_reason,
      native_value_raw=EXCLUDED.native_value_raw,logs=EXCLUDED.logs,decoder_version=EXCLUDED.decoder_version WHERE node_executions.block_hash=EXCLUDED.block_hash`,
    [entry.id, entry.txHash, entry.walletAddress, entry.executionIndex, entry.operationHash, entry.blockNumber, entry.blockHash, entry.transactionIndex, entry.timestamp, entry.status, entry.kind,
      entry.feeNativeWei, entry.feeComplete, entry.feeReason, entry.nativeValueRaw, JSON.stringify(entry.logs), NODE_EXECUTION_VERSION]);
    await database.query('DELETE FROM node_execution_flows WHERE execution_id=$1', [entry.id]);
    for (const flow of entry.flows) await database.query(`INSERT INTO node_execution_flows(execution_id,token_address,delta_raw,log_indices,counterparties) VALUES($1,$2,$3,$4,$5)`, [entry.id, flow.tokenAddress, flow.deltaRaw, flow.logIndices, flow.counterparties]);
  }
  await queueNodeTraceExecutions(database,executions);
}
