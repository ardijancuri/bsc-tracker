import type { PoolClient } from 'pg';
import { rebuildFreshScopesAfterReorg } from './accounting.js';
import { classifyFreshCreationToken, type FreshTokenAuthenticityProof } from './tokenAuthenticity.js';

export type FreshCreationContext = Parameters<typeof classifyFreshCreationToken>[0];
export interface FreshAuthenticityRepairResult {
  tokens: string[];
  excludedLaunches: number;
  excludedTokens: number;
  invalidatedEvents: number;
  rebuiltScopes: number;
  queuedReceipts: number;
}

/** Caller owns BEGIN/COMMIT/ROLLBACK. All creation/canonicality checks precede
 * writes, and the decoder's transaction lock serializes financial corrections.
 * No receipt, original financial field, identity or boundary is deleted. */
export async function repairFreshNonledgerCreations(client: PoolClient, contexts: FreshCreationContext[], now = new Date()): Promise<FreshAuthenticityRepairResult> {
  if (!Number.isFinite(now.getTime()) || contexts.length > 64) throw new Error('authenticity_repair_input_invalid');
  const proven = new Map<string, FreshTokenAuthenticityProof>();
  for (const context of contexts) {
    const proof = classifyFreshCreationToken(context);
    if (!proof) throw new Error('authenticity_creation_unproven');
    const token = proof.creationEvidence.receipt.contractAddress;
    const previous = proven.get(token);
    if (previous && JSON.stringify(previous) !== JSON.stringify(proof)) throw new Error('authenticity_creation_conflict');
    proven.set(token, proof);
  }
  const tokens = [...proven.keys()].sort(), result: FreshAuthenticityRepairResult = {
    tokens, excludedLaunches: 0, excludedTokens: 0, invalidatedEvents: 0, rebuiltScopes: 0, queuedReceipts: 0,
  };
  if (!tokens.length) return result;
  await client.query('SELECT pg_advisory_xact_lock(73621941)');

  // A syntactically correct caller-provided context is insufficient: it must
  // identify the original creation fact and its retained canonical header.
  const validated: { token: string; proof: FreshTokenAuthenticityProof; changed: boolean }[] = [];
  for (const token of tokens) {
    const proof = proven.get(token)!, creation = proof.creationEvidence;
    const saved = (await client.query(`SELECT f.protocol,f.block_number,f.block_hash,f.tx_hash,f.log_index,f.status,f.proof->>'creator' AS creator,
      f.proof->>'creation' AS creation,f.proof->'authenticity' AS authenticity,
      f.proof->'authenticity'=$2::jsonb AS proof_matches,b.block_hash AS canonical_hash,b.parent_hash,b.occurred_at
      FROM fresh.launch_facts f LEFT JOIN fresh.recent_blocks b ON b.block_number=f.block_number
      WHERE f.token_address=$1 FOR UPDATE OF f`, [token, JSON.stringify(proof)])).rows[0];
    if (!saved || saved.protocol !== 'evm_creation' || saved.log_index !== null || saved.creation !== 'top_level'
      || saved.creator !== creation.transaction.from || BigInt(saved.block_number) !== BigInt(creation.block.number)
      || saved.block_hash !== creation.block.hash || saved.tx_hash !== creation.transaction.hash
      || saved.canonical_hash !== creation.block.hash || saved.parent_hash !== creation.block.parentHash
      || new Date(saved.occurred_at).getTime() !== Number(BigInt(creation.block.timestamp)) * 1_000) throw new Error('authenticity_creation_not_canonical');
    if (saved.authenticity != null && !saved.proof_matches) throw new Error('authenticity_creation_proof_conflict');
    validated.push({ token, proof, changed: saved.status !== 'excluded_non_token' || saved.authenticity == null });
  }

  const affectedScopes = (await client.query(`SELECT s.id FROM fresh.accounting_scopes s WHERE
    EXISTS(SELECT 1 FROM fresh.positions p WHERE p.scope_id=s.id AND p.token_address=ANY($1::text[])) OR
    EXISTS(SELECT 1 FROM fresh.scope_event_results r JOIN fresh.financial_events e ON e.id=r.event_id
      WHERE r.scope_id=s.id AND e.token_address=ANY($1::text[])) ORDER BY s.id`, [tokens])).rows.map(row => row.id as string);
  const canonicalEvents = (await client.query(`SELECT id,token_address,transaction_hash,block_hash FROM fresh.financial_events
    WHERE canonical AND token_address=ANY($1::text[]) ORDER BY block_number,transaction_index,id FOR UPDATE`, [tokens])).rows;
  const changedTokens = new Set(validated.filter(row => row.changed).map(row => row.token));
  for (const event of canonicalEvents) changedTokens.add(event.token_address);

  for (const { token, proof, changed } of validated) {
    if (changed) result.excludedLaunches += (await client.query(`UPDATE fresh.launch_facts SET status='excluded_non_token',
      proof=jsonb_set(proof,'{authenticity}',$2::jsonb,true) WHERE token_address=$1`, [token, JSON.stringify(proof)])).rowCount ?? 0;
    const updated = await client.query(`UPDATE fresh.tokens SET launch_status='excluded_non_token',valuation_status='excluded_non_token',revision=revision+1
      WHERE address=$1 AND (launch_status<>'excluded_non_token' OR valuation_status<>'excluded_non_token')`, [token]);
    result.excludedTokens += updated.rowCount ?? 0;
    if (updated.rowCount) changedTokens.add(token);
  }
  if (canonicalEvents.length) result.invalidatedEvents = (await client.query(`UPDATE fresh.financial_events SET canonical=false
    WHERE id=ANY($1::text[]) AND canonical`, [canonicalEvents.map(row => row.id)])).rowCount ?? 0;
  if (affectedScopes.length) result.rebuiltScopes = (await rebuildFreshScopesAfterReorg(client, affectedScopes, now)).rebuiltScopes;

  // Retained receipt payloads may contain legitimate assets too. Schedule the
  // normal whole-receipt decoder, preserving every existing first diagnostic.
  if (changedTokens.size) {
    const receipts = (await client.query(`SELECT DISTINCT e.tx_hash,e.block_hash FROM fresh.recent_evidence e
      JOIN fresh.financial_events f ON f.transaction_hash=e.tx_hash AND f.block_hash=e.block_hash
      WHERE f.token_address=ANY($1::text[]) ORDER BY e.tx_hash,e.block_hash`, [[...changedTokens]])).rows;
    for (const receipt of receipts) {
      await client.query(`UPDATE fresh.recent_evidence SET decoder_status='pending' WHERE tx_hash=$1 AND block_hash=$2`, [receipt.tx_hash, receipt.block_hash]);
      const reference = `${receipt.tx_hash}:${receipt.block_hash}`;
      await client.query(`INSERT INTO fresh.jobs(id,kind,reference,priority,due_at) VALUES($1,'decode_receipt',$2,80,$3)
        ON CONFLICT(kind,reference) DO UPDATE SET state='pending',due_at=EXCLUDED.due_at,updated_at=EXCLUDED.due_at,
        lease_id=NULL,lease_until=NULL`, [`decode:${reference}`, reference, now]);
    }
    result.queuedReceipts = receipts.length;
    for (const { token, proof } of validated.filter(row => changedTokens.has(row.token))) {
      const progress = { version: 1, classification: proof.classification, templateId: proof.templateId,
        creationBlock: String(BigInt(proof.creationEvidence.block.number)), creationHash: proof.creationEvidence.block.hash,
        creationTx: proof.creationEvidence.transaction.hash, correctedAt: now.toISOString(),
        invalidatedEvents: canonicalEvents.filter(event => event.token_address === token).length, rebuiltScopes: result.rebuiltScopes };
      await client.query(`INSERT INTO fresh.jobs(id,kind,reference,state,progress,due_at,updated_at)
        VALUES($1,'token_authenticity_correction',$2,'completed',$3::jsonb,$4,$4)
        ON CONFLICT(kind,reference) DO UPDATE SET state='completed',progress=EXCLUDED.progress,updated_at=EXCLUDED.updated_at`,
      [`authenticity:${token}`, token, JSON.stringify(progress), now]);
    }
  }
  return result;
}
