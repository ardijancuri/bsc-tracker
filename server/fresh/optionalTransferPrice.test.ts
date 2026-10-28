import{describe,it,expect}from'vitest';
import{freshReceiptOptionalTransferPriceSql,freshPositionReceiptRelevantSql}from'./positionDependencies.js';
import{freshDailyLeaderboardPendingSql,freshRollingLeaderboardPendingSql}from'./leaderboard.js';
import{FRESH_TRANSFER_VALUE_WARNINGS}from'./deferredTransferValuation.js';
describe('fully applied optional transfer-price repairs',()=>{
 it('requires the exact policy, canonical receipt, authenticated dependency index and warning allowlist',()=>{
  const sql=freshReceiptOptionalTransferPriceSql('e','s');
  for(const warning of FRESH_TRANSFER_VALUE_WARNINGS)expect(sql).toContain(`'${warning}'`);
  expect(sql).toContain("e.decoder_status='repair'");expect(sql).toContain('sales_fifo_fees_v2');
  expect(sql).toContain('NOT (e.position_dependency_addresses IS NULL');expect(sql).toContain('price_block.block_hash=e.block_hash');
  expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b|payload|expires_at/i);
 });
 it('covers every own scoped fact using its exact result identity and known fee, without substituting another book',()=>{
  const sql=freshReceiptOptionalTransferPriceSql('e','s');
  for(const fragment of['price_fact.wallet_address=ANY(s.wallet_addresses)','price_result.scope_id=s.id AND price_result.event_id=price_fact.id',
   'price_result.token_address IS DISTINCT FROM price_fact.token_address','price_result.fee_q IS NULL','price_result.realized_q IS NULL',
   "price_fact.kind IN('buy','sell') AND price_fact.amount_usd IS NULL",'price_member.registration_block','price_member.activity_from',
   'price_pending.transaction_hash=e.tx_hash','NOT EXISTS(SELECT 1 FROM fresh.financial_events promoted'])expect(sql).toContain(fragment);
 });
 it('uses the same scope coverage gate for position and both ranking periods',()=>{
  expect(freshPositionReceiptRelevantSql('e','p.token_address','s')).toContain(freshReceiptOptionalTransferPriceSql('e','s'));
  for(const sql of[freshDailyLeaderboardPendingSql(),freshRollingLeaderboardPendingSql()]){
   expect(sql).toContain("price_scope.id='kol:'||w.address");expect(sql).toContain(freshReceiptOptionalTransferPriceSql('e','price_scope'));
  }
  expect(freshPositionReceiptRelevantSql('e','p.token_address')).not.toContain('price_result');
 });
 it.each([['e;DELETE','s'],['e','s;DELETE'],['x.y','s']])('rejects malformed composition %s %s',(e,s)=>expect(()=>freshReceiptOptionalTransferPriceSql(e,s)).toThrow());
});
