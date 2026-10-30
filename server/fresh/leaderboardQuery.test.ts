import{describe,it,expect}from'vitest';
import{freshLeaderboardPendingReceiptsSql}from'./leaderboardQuery.js';
import{freshRollingLeaderboardPendingSql,freshPublicTokenDiscoveryPendingSql}from'./leaderboard.js';
import{freshAuthenticatedTokenBirthBlockSql}from'./positionDependencies.js';
describe('bounded public leaderboard evidence input',()=>{
 it('materializes narrow pending receipts once with an indexed canonical header lookup',()=>{
  expect(freshLeaderboardPendingReceiptsSql).toContain('AS MATERIALIZED');expect(freshLeaderboardPendingReceiptsSql).toContain('LEFT JOIN LATERAL');
  expect(freshLeaderboardPendingReceiptsSql).toContain('b.block_number=e.block_number AND b.block_hash=e.block_hash LIMIT 1');
  expect(freshLeaderboardPendingReceiptsSql).not.toMatch(/payload|e\.\*/);expect(freshLeaderboardPendingReceiptsSql).toContain("decoder_status<>'done'");
 });
 it('retains strict missing headers and private/discovery boundaries',()=>{
  const s=freshRollingLeaderboardPendingSql(true);expect(s).toContain('h.block_number IS NULL');expect(s).toContain('e.wallet_addresses@>ARRAY[w.address]');
  expect(s).toContain('fresh.pending_trades');const d=freshPublicTokenDiscoveryPendingSql(true);expect(d).toContain('discovery_block.block_number IS NOT NULL');
  expect(d).toContain('discovery_scope.account_id IS NULL');expect(d).toContain("discovery_scope.kind='kol'");
 });
 it('uses the same birth proof with a selected token while retaining both canonical headers',()=>{
  const s=freshAuthenticatedTokenBirthBlockSql('active.token_address',{selectedToken:true});expect(s).toContain('token_birth.token_address=active.token_address');
  expect(s).toContain('JOIN fresh.recent_blocks born');expect(s).toContain('JOIN fresh.recent_blocks parent');expect(s).not.toContain('jsonb_object_agg');
  expect(s).not.toContain('LEFT JOIN fresh.recent_blocks current_birth');
 });
});
