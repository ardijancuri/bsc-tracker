import { createHash } from 'node:crypto';
import { freshAddress, freshHash, freshInteger, validateFreshReceipt, type FreshCapturedReceipt } from './capture.js';
import { freshTraceMatchesTransaction, validateFreshTrace } from './trace.js';
import {freshTrackedEventSql,freshScopeEventSql,freshScopeWalletMonitoringSql} from './tracking.js';
import {kolProfileTokenSql} from '../kolProfileToken.js';
import{freshScopeTokenCaptureSql}from'./gangTokenCoverage.js';

export interface FreshPositionDependencies { version: 1; addresses: string[]; proofHash: string }
const callTypes = new Set(['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);

/** A complete captured callTracer tree bounds every contract entered by this
 * execution. Logs alone do not: an opaque caller may change token storage
 * without emitting Transfer. Untraced or malformed evidence stays global.
 * This is a small temporary index of the original 72-hour evidence, never
 * financial approval or a substitute for a canonical balance check. */
export function freshPositionDependencies(entry: FreshCapturedReceipt): FreshPositionDependencies | null {
  try {
    if (!entry.trace || entry.receipt.status !== '0x1') return null;
    if (!freshHash(entry.transaction.hash) || !freshHash(entry.transaction.blockHash) || freshHash(entry.transaction.blockHash) !== freshHash(entry.receipt.blockHash)
      || freshInteger(entry.transaction.blockNumber) !== freshInteger(entry.receipt.blockNumber)) return null;
    validateFreshReceipt(entry.receipt, entry.transaction, { number: entry.receipt.blockNumber, hash: entry.receipt.blockHash,
      parentHash: entry.receipt.blockHash, timestamp: '0x0', transactions: [entry.transaction] });
    const trace = validateFreshTrace(entry.trace);
    if (!freshTraceMatchesTransaction(trace, entry.transaction)
      || typeof entry.transaction.input !== 'string' || trace.input !== entry.transaction.input.toLowerCase()) return null;
    const addresses = new Set<string>();
    const add = (value: unknown) => { const address = freshAddress(value); if (address) addresses.add(address); };
    const visit = (call: typeof trace) => {
      if (!callTypes.has(call.type) || !call.to) throw Error('position_dependency_trace_opaque');
      add(call.from); add(call.to); call.calls?.forEach(visit);
    };
    visit(trace); entry.receipt.logs.forEach(log => add(log.address));
    add(entry.transaction.from); add(entry.transaction.to); add(entry.receipt.contractAddress);
    if (addresses.size > 512) return null;
    return { version: 1, addresses: [...addresses].sort(), proofHash: createHash('sha256')
      .update(JSON.stringify([entry.transaction, entry.receipt, trace])).digest('hex') };
  } catch { return null; }
}

/** NULL means opaque and therefore blocks every book containing this wallet.
 * A proven complete tree can instead block just contracts it actually touched. */
export const freshPositionReceiptOpaqueSql = (e: string) =>
  `(${e}.position_dependency_addresses IS NULL OR cardinality(${e}.position_dependency_addresses)=0
    OR ${e}.position_dependency_proof IS NULL OR ${e}.position_dependency_proof!~'^[0-9a-f]{64}$'
  )`;
/** A genuine code-creation proof can bound a token's existence, unlike a pool
 * launch timestamp. Same-block receipts and contradictory positive token
 * evidence remain relevant. The receipt/repair itself is never changed. */
export function freshPositionReceiptPredatesTokenBirthSql(receipt:string,token:string){
 const e=pendingAlias(receipt),t=pendingTokenExpression(token),proof='token_birth.proof';
 return`EXISTS(SELECT 1 FROM fresh.launch_facts token_birth
  JOIN fresh.checkpoints token_start ON token_start.key='start'
  JOIN fresh.recent_blocks born ON born.block_number=token_birth.block_number AND born.block_hash=token_birth.block_hash
  JOIN fresh.recent_blocks parent ON parent.block_number=token_birth.block_number-1 AND parent.block_hash=born.parent_hash
  WHERE token_birth.token_address=${t} AND token_birth.status='eligible' AND token_birth.protocol='evm_creation' AND token_birth.log_index IS NULL
   AND ${e}.block_number<token_birth.block_number AND token_birth.block_number>token_start.block_number
   AND token_start.value->>'startBlock'=token_start.block_number::text AND token_start.value->>'startHash'=token_start.block_hash
   AND token_birth.launched_at=born.occurred_at AND ${proof}->'version'='1'::jsonb AND ${proof}->>'kind'='canonical_token_birth_v1'
   AND ${proof}->>'source' IN('node','explicit_archive') AND ${proof}->>'codeBefore'='0x'
   AND ${proof}->'start'=jsonb_build_object('number',token_start.block_number,'hash',token_start.block_hash)
   AND ${proof}->'birth'=jsonb_build_object('number',born.block_number,'hash',born.block_hash,'parentHash',born.parent_hash,
    'timestamp',to_char(born.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   AND ${proof}->'parent'=jsonb_build_object('number',parent.block_number,'hash',parent.block_hash,'parentHash',parent.parent_hash,
    'timestamp',to_char(parent.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   AND ${proof}->'creationTransactionKnown'='true'::jsonb AND ${proof}->>'witnessTransactionHash'=token_birth.tx_hash
   AND token_birth.tx_hash~'^0x[0-9a-f]{64}$' AND ${proof}->>'creator'~'^0x[0-9a-f]{40}$'
   AND ${proof}->>'originalContextSha256'~'^[0-9a-f]{64}$' AND ${proof}->>'runtimeSha256'~'^[0-9a-f]{64}$'
   AND CASE WHEN ${proof}->>'runtimeBytes'~'^[1-9][0-9]{0,5}$' THEN (${proof}->>'runtimeBytes')::integer<=131072 ELSE false END
   AND((${proof}->>'creation'='top_level_creation' AND NOT(${proof}?'creationFrame')) OR(
    ${proof}->>'creation'='internal_creation' AND ${proof}->'creationFrame'->>'type' IN('CREATE','CREATE2')
    AND ${proof}->'creationFrame'->>'creator'=${proof}->>'creator'
    AND ${proof}->'creationFrame'->>'runtimeSha256'=${proof}->>'runtimeSha256'
    AND ${proof}->'creationFrame'->>'inputSha256'~'^[0-9a-f]{64}$'
    AND CASE WHEN jsonb_typeof(${proof}->'creationFrame'->'path')='array' THEN
     jsonb_array_length(${proof}->'creationFrame'->'path') BETWEEN 1 AND 64 AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(${proof}->'creationFrame'->'path') step
       WHERE jsonb_typeof(step)<>'number' OR step#>>'{}'!~'^(0|[1-9][0-9]{0,8})$') ELSE false END))
   AND NOT EXISTS(SELECT 1 FROM fresh.financial_events explicit_token WHERE explicit_token.canonical
    AND explicit_token.token_address=${t} AND explicit_token.transaction_hash=${e}.tx_hash AND explicit_token.block_hash=${e}.block_hash))`;
}
export const freshPositionReceiptRelevantSql = (e: string, token: string) =>
  `(COALESCE(${token}=ANY(${e}.position_dependency_addresses),false) OR(${freshPositionReceiptOpaqueSql(e)} AND NOT ${freshPositionReceiptPredatesTokenBirthSql(e,token)}))`;

const pendingAlias=(value:string)=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw Error('pending_trade_sql_alias_invalid');return value;};
const pendingTokenExpression=(value:string)=>{if(!/^(?:[a-z_][a-z0-9_]*\.){1,2}[a-z_][a-z0-9_]*$|^\$[1-9][0-9]*$/i.test(value))throw Error('pending_trade_sql_token_invalid');return value;};
const pendingCapture="(SELECT block_number FROM fresh.checkpoints WHERE key='capture')";
const pendingBlockExpression=(value:string)=>{if(value!==pendingCapture&&!/^\$[1-9][0-9]*$|^[0-9]+$|^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(value))throw Error('pending_trade_sql_block_invalid');return value;};

/** Compact canonical swap observations outlive the temporary receipt buffer.
 * They cannot approve accounting until their exact execution is normalized.
 * No raw receipt scan or valuation is performed by this indexed identity gate. */
export function freshPendingTradeInScopeSql(pending='pending',scope='s',throughBlock=pendingCapture){
 const e=pendingAlias(pending),s=pendingAlias(scope),capture=freshScopeTokenCaptureSql(s,e+'.token_address'),through=throughBlock===pendingCapture?capture:pendingBlockExpression(throughBlock);
 return`(${e}.canonical AND ${e}.kind IN('buy','sell') AND ${s}.active
  AND ${e}.wallet_address=ANY(${s}.wallet_addresses) AND ${freshScopeEventSql(e,s)}
  AND ${e}.block_number<=${through} AND ${e}.block_number<=${capture}
  AND NOT EXISTS(SELECT 1 FROM fresh.financial_events promoted WHERE promoted.canonical AND (promoted.id=${e}.id OR promoted.execution_key=${e}.execution_key))
  AND EXISTS(SELECT 1 FROM fresh.tokens pending_token WHERE pending_token.address=${e}.token_address
   AND ${freshTrackedEventSql(e,'pending_token')} AND ${kolProfileTokenSql('pending_token')})
  AND EXISTS(SELECT 1 FROM fresh.wallets monitored WHERE monitored.address=${e}.wallet_address
   AND ${freshScopeWalletMonitoringSql(e,s,'monitored')} AND(monitored.monitoring_to_block IS NULL OR ${e}.block_number<=monitored.monitoring_to_block))
  AND ((${s}.kind='kol' AND ${s}.account_id IS NULL AND ${s}.id='kol:'||${e}.wallet_address
   AND EXISTS(SELECT 1 FROM fresh.kols public_kol WHERE public_kol.wallet_address=${e}.wallet_address AND public_kol.is_tracked))
   OR (${s}.kind IN('portfolio_wallet','portfolio_combined') AND ${s}.account_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.journal_wallets membership WHERE membership.user_id::text=${s}.account_id AND membership.wallet_address=${e}.wallet_address
     AND ${e}.block_number>=greatest(${s}.starts_block,coalesce(membership.registration_block,${s}.starts_block))
     AND ${e}.occurred_at>=greatest(${s}.starts_at,membership.activity_from)))))`;
}
export function freshPendingTradeScopeSql(scope='s',token='p.token_address',throughBlock=pendingCapture){
 const s=pendingAlias(scope),t=pendingTokenExpression(token),through=pendingBlockExpression(throughBlock);
 return`EXISTS(SELECT 1 FROM fresh.pending_trades pending WHERE pending.token_address=${t} AND ${freshPendingTradeInScopeSql('pending',s,through)})`;
}
