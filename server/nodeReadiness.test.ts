import { describe, expect, it } from 'vitest';
import { nodeOperationalReadiness, type NodeReadinessInput } from './nodeReadiness.js';

const current: NodeReadinessInput = { headBlock: 1_000_000, collectedBlock: 999_993, decodedBlock: 999_991,
  marketCollectedBlock: 999_990, traceIpcConfigured: true, privateTraceVerifiedAt: '2026-10-19T17:59:00Z', observedAt: '2026-10-19T18:00:00Z' };

describe('separate body, state and private trace readiness', () => {
  it('reports current supported capture without external financial credentials', () => {
    const result = nodeOperationalReadiness(current);
    expect(result.readyForUnattendedNodeCapture).toBe(true);
    expect(result.collection.pruningMarginBlocks).toBe(599_993);
    expect(result.stateRetentionBlocks).toBe(128);
    expect(result.nativeTrace.transport).toBe('private_ipc');
  });
  it('does not confuse three days of bodies with a usable old trace state', () => {
    const result = nodeOperationalReadiness({ ...current, oldestPendingTraceBlock: 999_871, pendingTraceJobs: 1 });
    expect(result.collection.pruningMarginBlocks).toBe(599_993);
    expect(result.stateEvidence.pruningMarginBlocks).toBe(-1);
    expect(result.reasons).toContain('required_state_window_exceeded');
    expect(result.readyForUnattendedNodeCapture).toBe(false);
  });
  it('keeps the exact retention boundary explicit for pending metadata', () => {
    expect(nodeOperationalReadiness({ ...current, oldestPendingMetadataBlock: 999_873 }).stateEvidence.pruningMarginBlocks).toBe(1);
    expect(nodeOperationalReadiness({ ...current, oldestPendingMetadataBlock: 999_872 }).reasons).toContain('required_state_window_exceeded');
  });
  it('includes registration repair in the permanent evidence pruning margin', () => {
    const result = nodeOperationalReadiness({ ...current, repairFromBlock: 400_000 });
    expect(result.collection.pruningMarginBlocks).toBe(0);
    expect(result.reasons).toContain('block_body_pruning_risk');
  });
  it('surfaces lag in independent collection, decoding and market stages', () => {
    const result = nodeOperationalReadiness({ ...current, collectedBlock: 999_871, decodedBlock: 999_870, marketCollectedBlock: 999_869 });
    expect(result.reasons).toEqual(['collection_behind_state_window', 'decoding_behind_state_window', 'market_collection_behind_state_window']);
  });
  it('never treats missing, future or malformed checkpoints as zero lag', () => {
    for (const collectedBlock of [null, NaN, Infinity, -1, 1_000_001]) {
      const result = nodeOperationalReadiness({ ...current, collectedBlock });
      expect(result.collection.lagBlocks).toBeNull();
      expect(result.readyForUnattendedNodeCapture).toBe(false);
    }
  });
  it('requires permanent trace wiring even when no current trace is queued', () => {
    const result = nodeOperationalReadiness({ ...current, traceIpcConfigured: false });
    expect(result.nativeTrace.pendingJobs).toBe(0);
    expect(result.reasons).toContain('private_trace_transport_unavailable');
  });
  it('does not mistake a configured IPC path for verified transport access', () => {
    for (const privateTraceVerifiedAt of [null, 'invalid', '2026-10-19T18:00:01Z']) {
      const result = nodeOperationalReadiness({ ...current, privateTraceVerifiedAt });
      expect(result.nativeTrace.transport).toBe('private_ipc');
      expect(result.nativeTrace.accessVerified).toBe(false);
      expect(result.reasons).toContain('private_trace_transport_unverified');
      expect(result.readyForUnattendedNodeCapture).toBe(false);
    }
  });
  it('preserves the original heartbeat and expiry of a temporary local helper', () => {
    const helper = { checkedAt: '2026-10-19T17:59:30Z', expiresAt: '2026-10-19T18:52:00Z' };
    const first = nodeOperationalReadiness({ ...current, traceIpcConfigured: false, temporaryTraceHelper: helper });
    expect(first.nativeTrace.transport).toBe('temporary_helper');
    expect(first.nativeTrace.helperCheckedAt).toBe(helper.checkedAt);
    expect(first.reasons).toContain('private_trace_transport_temporary');
    expect(first.readyForUnattendedNodeCapture).toBe(false);
    const later = nodeOperationalReadiness({ ...current, traceIpcConfigured: false, temporaryTraceHelper: helper, observedAt: '2026-10-19T18:01:01Z' });
    expect(later.nativeTrace.transport).toBe('unconfigured');
    expect(later.nativeTrace.helperCheckedAt).toBe(helper.checkedAt);
  });
  it('rejects expired and future helper heartbeats without inventing liveness', () => {
    for (const temporaryTraceHelper of [{ checkedAt: '2026-10-19T17:59:59Z', expiresAt: '2026-10-19T18:00:00Z' },
      { checkedAt: '2026-10-19T18:00:01Z' }, { checkedAt: 'invalid' }]) {
      expect(nodeOperationalReadiness({ ...current, traceIpcConfigured: false, temporaryTraceHelper }).nativeTrace.helperFresh).toBe(false);
    }
  });
  it('reports a confirmed missing native proof independently of pending retry age', () => {
    const result = nodeOperationalReadiness({ ...current, unavailableTraceJobs: 1 });
    expect(result.reasons).toContain('native_trace_evidence_unavailable');
    expect(result.readyForUnattendedNodeCapture).toBe(false);
  });
});
