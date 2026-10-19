/** Operational evidence, not a promise that an unsupported protocol or unknown
 * opening position can be accounted for. Block bodies and historical state have
 * different retention windows on the ordinary BSC node. */
export type NodeReadinessInput = {
  headBlock: number;
  collectedBlock: number | null;
  decodedBlock: number | null;
  marketCollectedBlock: number | null;
  repairFromBlock?: number | null;
  bodyRetentionBlocks?: number;
  stateRetentionBlocks?: number;
  oldestPendingMetadataBlock?: number | null;
  pendingMetadataJobs?: number;
  oldestPendingTraceBlock?: number | null;
  pendingTraceJobs?: number;
  unavailableTraceJobs?: number;
  traceIpcConfigured: boolean;
  /** Successful bounded capture through this worker's configured IPC transport.
   * Merely setting an environment path does not prove permissions or access. */
  privateTraceVerifiedAt?: string | null;
  /** External local validation must retain its original heartbeat and expiry;
   * reading it again does not renew its liveness. */
  temporaryTraceHelper?: { checkedAt: string; expiresAt?: string } | null;
  observedAt: string;
};

const block = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const count = (value: number | undefined) => block(value) ? value : 0;
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function nodeOperationalReadiness(input: NodeReadinessInput) {
  const head = block(input.headBlock) ? input.headBlock : null;
  const bodyRetention = block(input.bodyRetentionBlocks) && input.bodyRetentionBlocks > 0 ? input.bodyRetentionBlocks : 600_000;
  const stateRetention = block(input.stateRetentionBlocks) && input.stateRetentionBlocks > 0 ? input.stateRetentionBlocks : 128;
  const lag = (height: number | null | undefined) => head !== null && block(height) && height <= head ? head - height : null;
  const collectionLag = lag(input.collectedBlock), decodeLag = lag(input.decodedBlock), marketLag = lag(input.marketCollectedBlock);
  const repairLag = lag(input.repairFromBlock);
  const bodyMargin = collectionLag === null ? null : bodyRetention - Math.max(collectionLag, repairLag ?? 0);
  const metadataLag = lag(input.oldestPendingMetadataBlock), traceLag = lag(input.oldestPendingTraceBlock);
  const requiredStateLags = [metadataLag, traceLag].filter((value): value is number => value !== null);
  const stateMargin = requiredStateLags.length ? stateRetention - Math.max(...requiredStateLags) : null;
  const observed = time(input.observedAt), helperChecked = time(input.temporaryTraceHelper?.checkedAt), helperExpiry = time(input.temporaryTraceHelper?.expiresAt);
  const helperFresh = observed !== null && helperChecked !== null && helperChecked <= observed && observed - helperChecked <= 90_000
    && (helperExpiry === null || helperExpiry > observed);
  const ipcVerified = time(input.privateTraceVerifiedAt);
  const ipcAccessVerified = input.traceIpcConfigured && observed !== null && ipcVerified !== null && ipcVerified <= observed;
  const traceTransport = input.traceIpcConfigured ? 'private_ipc' : helperFresh ? 'temporary_helper' : 'unconfigured';
  const reasons: string[] = [];
  if (collectionLag === null || decodeLag === null || marketLag === null) reasons.push('checkpoint_unavailable');
  if (bodyMargin !== null && bodyMargin <= 0) reasons.push('block_body_pruning_risk');
  if (collectionLag !== null && collectionLag > stateRetention) reasons.push('collection_behind_state_window');
  if (decodeLag !== null && decodeLag > stateRetention) reasons.push('decoding_behind_state_window');
  if (marketLag !== null && marketLag > stateRetention) reasons.push('market_collection_behind_state_window');
  if (stateMargin !== null && stateMargin <= 0) reasons.push('required_state_window_exceeded');
  if (count(input.unavailableTraceJobs)) reasons.push('native_trace_evidence_unavailable');
  if (traceTransport === 'unconfigured') reasons.push('private_trace_transport_unavailable');
  if (traceTransport === 'temporary_helper') reasons.push('private_trace_transport_temporary');
  if (traceTransport === 'private_ipc' && !ipcAccessVerified) reasons.push('private_trace_transport_unverified');
  return {
    observedAt: input.observedAt,
    bodyRetentionBlocks: bodyRetention,
    stateRetentionBlocks: stateRetention,
    collection: { lagBlocks: collectionLag, pruningMarginBlocks: bodyMargin },
    decoding: { lagBlocks: decodeLag },
    marketCollection: { lagBlocks: marketLag },
    stateEvidence: { pruningMarginBlocks: stateMargin, oldestMetadataLagBlocks: metadataLag,
      oldestTraceLagBlocks: traceLag, pendingMetadataJobs: count(input.pendingMetadataJobs) },
    nativeTrace: { transport: traceTransport, permanent: input.traceIpcConfigured, accessVerified: ipcAccessVerified,
      verifiedAt: input.privateTraceVerifiedAt ?? null, pendingJobs: count(input.pendingTraceJobs),
      unavailableJobs: count(input.unavailableTraceJobs), helperCheckedAt: input.temporaryTraceHelper?.checkedAt ?? null,
      helperExpiresAt: input.temporaryTraceHelper?.expiresAt ?? null, helperFresh },
    // A temporary testing adapter is useful evidence for the local test but
    // cannot establish readiness for unattended production operation.
    readyForUnattendedNodeCapture: reasons.length === 0,
    reasons,
  };
}
