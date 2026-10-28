import{describe,it,expect,vi}from'vitest';
import type{Pool}from'pg';
import{freshPendingTradeInScopeSql,freshPendingTradeScopeSql}from'./positionDependencies.js';
import{freshDailyLeaderboardPendingSql,freshRollingLeaderboardPendingSql,freshStoredKolRollingMetrics}from'./leaderboard.js';
import{createFreshServices}from'./services.js';

describe('permanent pending swap accounting safety',()=>{
 it('uses compact canonical identities, never expiring raw receipts or financial value scans',()=>{
  const sql=freshPendingTradeScopeSql();
  expect(sql).toContain('fresh.pending_trades');expect(sql).toContain('pending.canonical');
  expect(sql).toContain('promoted.id=pending.id OR promoted.execution_key=pending.execution_key');
  expect(sql).toContain("s.id='kol:'||pending.wallet_address");expect(sql).toContain('membership.registration_block');expect(sql).toContain('membership.activity_from');
  expect(sql).not.toMatch(/recent_evidence|expires_at|\bSUM\(/i);
 });
 it('keeps permanent gaps in both stored ranking periods and never ranks a partial stored subtotal',()=>{
  for(const sql of[freshDailyLeaderboardPendingSql(),freshRollingLeaderboardPendingSql()]){
   expect(sql).toContain('fresh.pending_trades');expect(sql).toContain('active.token_address=pending.token_address');
  }
  expect(freshStoredKolRollingMetrics({rolling_as_of:'2026-10-25T12:00:00Z',rolling_realized_q:'100',rolling_known_realized_q:'100',decoding_pending:true},Date.parse('2026-10-25T12:00:01Z')))
   .toMatchObject({complete:false,realizedProfitUsd:null,knownRealizedProfitUsd:'100',reasons:['decoding_pending']});
 });
 it.each([()=>freshPendingTradeScopeSql('s;DELETE'),()=>freshPendingTradeScopeSql('s','p.token_address;SELECT'),()=>freshPendingTradeInScopeSql('pending','s','1;SELECT')])('rejects malformed SQL composition',call=>expect(call).toThrow());
 it('requires a replay cutoff and rechecks admission plus permanent pending facts at that cutoff',async()=>{
  const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[]})),service=createFreshServices({query}as unknown as Pool);
  expect(await service.validateRevision({cutoffBlock:null}as any)).toBe(false);expect(query).not.toHaveBeenCalled();
  const cutoffHash='0x'+'a'.repeat(64);
  expect(await service.validateRevision({cutoffBlock:'100',cutoffHash,scopeId:'scope',token:'token'}as any)).toBe(false);
  expect(query.mock.calls[0]).toEqual([expect.stringContaining('pending.block_number<=$3'),['scope','token','100',cutoffHash]]);
  expect(query.mock.calls[0][0]).toContain('b.block_number=$3 AND b.block_hash=$4');
  expect(query.mock.calls[0][0]).toContain('fresh.tokens t');expect(query.mock.calls[0][0]).toContain('token_admission:');
 });
});
