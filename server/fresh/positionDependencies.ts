import { createHash } from 'node:crypto';
import { freshAddress, freshHash, freshInteger, validateFreshReceipt, type FreshCapturedReceipt } from './capture.js';
import { freshTraceMatchesTransaction, validateFreshTrace } from './trace.js';
import {freshTrackedEventSql,freshScopeEventSql,freshScopeWalletMonitoringSql} from './tracking.js';
import {kolProfileTokenSql} from '../kolProfileToken.js';
import{freshScopeTokenCaptureSql}from'./gangTokenCoverage.js';
import{freshKnownProtocolTokenBirthSql}from'./tokenBirth.js';
import{FRESH_TRANSFER_VALUE_WARNINGS}from'./deferredTransferValuation.js';
import{freshRealizedPolicyReadySql}from'./realizedPolicy.js';
import{transferTopic}from'../swap.js';

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
    visit(trace); entry.receipt.logs.forEach(log => {
      add(log.address);
      // A passive ERC-20 beneficiary need not execute code. Keep the exact
      // canonical Transfer participants alongside the existing call/emitter
      // index; they do not approve a price, cost, event or balance. ERC-721,
      // malformed and non-address topics cannot supply these participants.
      if(log.topics.length!==3||log.topics[0]!==transferTopic||!/^0x[0-9a-f]{64}$/.test(log.data)
        ||!log.topics.slice(1).every(topic=>/^0x0{24}[0-9a-f]{40}$/.test(topic)))return;
      add('0x'+log.topics[1].slice(-40));add('0x'+log.topics[2].slice(-40));
    });
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
export function freshAuthenticatedTokenBirthBlockSql(token:string,options:{durableCertificate?:boolean;selectedToken?:boolean}={}){
 const t=pendingTokenExpression(token),proof='token_birth.proof',selected=options.durableCertificate||options.selectedToken;
 const parentIdentity=options.durableCertificate?`jsonb_build_object('number',token_birth.block_number-1,'hash',born.parent_hash,
  'parentHash',COALESCE(current_parent.parent_hash,${proof}->'parent'->>'parentHash'),
  'timestamp',COALESCE(to_char(current_parent.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),${proof}->'parent'->>'timestamp'))`:
  `jsonb_build_object('number',parent.block_number,'hash',parent.block_hash,'parentHash',parent.parent_hash,
    'timestamp',to_char(parent.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
 // Receipt scans share one birth map. Current-position queries validate only
 // the selected indexed creation certificate, avoiding an all-history scan.
 const rows=`SELECT ${selected?'token_birth.block_number':'jsonb_object_agg(token_birth.token_address,token_birth.block_number)'} FROM fresh.launch_facts token_birth
  JOIN fresh.checkpoints token_start ON token_start.key='start'
  ${options.durableCertificate?`JOIN fresh.checkpoints birth_capture ON birth_capture.key='capture' AND birth_capture.block_number>=token_birth.block_number
  CROSS JOIN LATERAL(SELECT token_birth.block_number,token_birth.block_hash,token_birth.launched_at AS occurred_at,
   COALESCE(token_birth.proof->'tokenBirth'->'birth'->>'parentHash',token_birth.proof->'birth'->>'parentHash') AS parent_hash)born
  LEFT JOIN fresh.recent_blocks current_birth ON current_birth.block_number=token_birth.block_number
  LEFT JOIN fresh.recent_blocks current_parent ON current_parent.block_number=token_birth.block_number-1
  LEFT JOIN fresh.recent_blocks parent ON parent.block_number=token_birth.block_number-1 AND parent.block_hash=born.parent_hash`:
  `JOIN fresh.recent_blocks born ON born.block_number=token_birth.block_number AND born.block_hash=token_birth.block_hash
  JOIN fresh.recent_blocks parent ON parent.block_number=token_birth.block_number-1 AND parent.block_hash=born.parent_hash`}
  WHERE token_birth.status='eligible'
   ${selected?`AND token_birth.token_address=${t}`:''}
   AND token_birth.block_number>token_start.block_number
   AND token_start.value->>'startBlock'=token_start.block_number::text AND token_start.value->>'startHash'=token_start.block_hash
   AND token_birth.launched_at=born.occurred_at
   ${options.durableCertificate?`AND born.parent_hash~'^0x[0-9a-f]{64}$'
   AND birth_capture.value->>'startBlock'=token_start.block_number::text AND birth_capture.value->>'startHash'=token_start.block_hash
   AND (current_parent.block_number IS NULL OR current_parent.block_hash=born.parent_hash)
   AND (current_birth.block_number IS NULL OR(current_birth.block_hash=born.block_hash AND current_birth.parent_hash=born.parent_hash AND current_birth.occurred_at=born.occurred_at))`:''}
   AND(${freshKnownProtocolTokenBirthSql()} OR(token_birth.protocol='evm_creation' AND token_birth.log_index IS NULL
   AND ${proof}->'version'='1'::jsonb AND ${proof}->>'kind'='canonical_token_birth_v1'
   AND ${proof}->>'source' IN('node','explicit_archive') AND ${proof}->>'codeBefore'='0x'
   AND ${proof}->'start'=jsonb_build_object('number',token_start.block_number,'hash',token_start.block_hash)
   AND ${proof}->'birth'=jsonb_build_object('number',born.block_number,'hash',born.block_hash,'parentHash',born.parent_hash,
    'timestamp',to_char(born.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   AND ${proof}->'parent'=${parentIdentity}
   ${options.durableCertificate?`AND ${proof}->'parent'->>'parentHash'~'^0x[0-9a-f]{64}$'
   AND ${proof}->'parent'->>'timestamp'~'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'`:''}
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
       WHERE jsonb_typeof(step)<>'number' OR step#>>'{}'!~'^(0|[1-9][0-9]{0,8})$') ELSE false END))))`;
 return selected?`(${rows})`:`((${rows}) ->> ${t})::bigint`;
}
export function freshPositionReceiptPredatesTokenBirthSql(receipt:string,token:string,selectedToken=false){
 const e=pendingAlias(receipt),t=pendingTokenExpression(token);
 return`(COALESCE(${e}.block_number<${freshAuthenticatedTokenBirthBlockSql(t,{selectedToken})},false)
   AND NOT EXISTS(SELECT 1 FROM fresh.financial_events explicit_token WHERE explicit_token.canonical
    AND explicit_token.token_address=${t} AND explicit_token.transaction_hash=${e}.tx_hash AND explicit_token.block_hash=${e}.block_hash))`;
}
/** Global accounting already blocks every opaque receipt. Reuse this cheap
 * identity predicate there; a per-token birth proof cannot waive that gate. */
export const freshPositionReceiptRawRelevantSql=(e:string,token:string)=>
 `(${freshPositionReceiptOpaqueSql(e)} OR ${token}=ANY(${e}.position_dependency_addresses))`;
export const freshPositionReceiptRelevantSql = (e: string, token: string, scope?:string,selectedToken=false) =>
  `((COALESCE(${token}=ANY(${e}.position_dependency_addresses),false) OR(${freshPositionReceiptOpaqueSql(e)} AND NOT ${freshPositionReceiptPredatesTokenBirthSql(e,token,selectedToken)}))${scope?` AND NOT ${freshReceiptOptionalTransferPriceSql(e,scope)}`:''})`;

const pendingAlias=(value:string)=>{if(!/^[a-z_][a-z0-9_]*$/i.test(value))throw Error('pending_trade_sql_alias_invalid');return value;};
const pendingTokenExpression=(value:string)=>{if(!/^(?:[a-z_][a-z0-9_]*\.){1,2}[a-z_][a-z0-9_]*$|^\$[1-9][0-9]*$/i.test(value))throw Error('pending_trade_sql_token_invalid');return value;};
const pendingCapture="(SELECT block_number FROM fresh.checkpoints WHERE key='capture')";
const pendingBlockExpression=(value:string)=>{if(value!==pendingCapture&&!/^\$[1-9][0-9]*$|^[0-9]+$|^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(value))throw Error('pending_trade_sql_block_invalid');return value;};

/** Price-only repair remains a real repair. Under sales/FIFO/fees accounting it
 * cannot change a book whose own canonical facts and charged fees are already
 * fully applied. Never borrow another wallet's result from a shared receipt.
 * Unknown incoming lot basis remains unknown; any actual unvalued buy/sell or
 * unpromoted swap still fails this gate. An opaque execution cannot use it. */
export function freshReceiptOptionalTransferPriceSql(receipt:string,scope:string){
 const e=pendingAlias(receipt),s=pendingAlias(scope),f='price_fact',r='price_result',t='price_token',w='price_wallet';
 const own=`${f}.canonical AND ${f}.block_number=${e}.block_number AND ${f}.block_hash=${e}.block_hash AND ${f}.transaction_hash=${e}.tx_hash
  AND ${f}.wallet_address=ANY(${s}.wallet_addresses) AND ${freshScopeEventSql(f,s)}
  AND (${s}.account_id IS NULL OR EXISTS(SELECT 1 FROM public.journal_wallets price_member
   WHERE price_member.user_id::text=${s}.account_id AND price_member.wallet_address=${f}.wallet_address
    AND ${f}.block_number>=coalesce(price_member.registration_block,${s}.starts_block) AND ${f}.occurred_at>=price_member.activity_from))`;
 return`COALESCE((${freshRealizedPolicyReadySql()} AND ${e}.decoder_status='repair'
  AND ${e}.last_error IN(${FRESH_TRANSFER_VALUE_WARNINGS.map(value=>`'${value}'`).join(',')})
  AND NOT ${freshPositionReceiptOpaqueSql(e)} AND cardinality(${e}.position_dependency_addresses)<=512
  AND ${s}.active AND ${e}.wallet_addresses&&${s}.wallet_addresses
  AND ((${s}.kind='kol' AND ${s}.account_id IS NULL AND cardinality(${s}.wallet_addresses)=1 AND ${s}.id='kol:'||${s}.wallet_addresses[1]
    AND EXISTS(SELECT 1 FROM fresh.kols price_kol WHERE price_kol.wallet_address=${s}.wallet_addresses[1] AND price_kol.is_tracked))
   OR (${s}.kind IN('portfolio_wallet','portfolio_combined') AND ${s}.account_id IS NOT NULL))
  AND EXISTS(SELECT 1 FROM fresh.recent_blocks price_block WHERE price_block.block_number=${e}.block_number AND price_block.block_hash=${e}.block_hash
   AND EXISTS(SELECT 1 FROM fresh.financial_events ${f} WHERE ${own})
   AND NOT EXISTS(SELECT 1 FROM fresh.financial_events ${f}
    LEFT JOIN fresh.scope_event_results ${r} ON ${r}.scope_id=${s}.id AND ${r}.event_id=${f}.id
    LEFT JOIN fresh.tokens ${t} ON ${t}.address=${f}.token_address
    LEFT JOIN fresh.wallets ${w} ON ${w}.address=${f}.wallet_address
    WHERE ${own} AND (${f}.occurred_at<>price_block.occurred_at OR ${r}.event_id IS NULL
     OR ${r}.token_address IS DISTINCT FROM ${f}.token_address OR ${r}.occurred_at<>${f}.occurred_at
     OR ${r}.fee_q IS NULL OR ${r}.realized_q IS NULL OR ${f}.fee_usd IS NULL
     OR ${f}.kind NOT IN('buy','sell','transfer_in','transfer_out','fee')
     OR (${f}.kind IN('buy','sell') AND ${f}.amount_usd IS NULL)
     OR ${f}.quantity!~'^(0|[1-9][0-9]*)(\\.[0-9]+)?$'
     OR ${w}.address IS NULL OR NOT ${w}.active OR NOT ${freshScopeWalletMonitoringSql(f,s,w)}
     OR (${w}.monitoring_to_block IS NOT NULL AND ${f}.block_number>${w}.monitoring_to_block)
     OR NOT COALESCE(${f}.wallet_address=ANY(${e}.position_dependency_addresses),false)
     OR (${f}.token_address IS NULL AND ${f}.kind<>'fee')
     OR (${f}.token_address IS NOT NULL AND NOT COALESCE((${t}.decimals BETWEEN 0 AND 255
      AND ${freshTrackedEventSql(f,t)} AND ${kolProfileTokenSql(t)}
      AND ${f}.token_address=ANY(${e}.position_dependency_addresses)),false)))))
  AND NOT EXISTS(SELECT 1 FROM fresh.pending_trades price_pending
   WHERE price_pending.block_number=${e}.block_number AND price_pending.block_hash=${e}.block_hash AND price_pending.transaction_hash=${e}.tx_hash
    AND ${freshPendingTradeInScopeSql('price_pending',s)})),false)`;
}

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
