import{describe,it,expect}from'vitest';
import{freshPublicTokenSql}from'./publicTokens.js';
import{freshTrackedTokenSql,freshTrackedEventSql,GANG_TOKEN_ADDRESS}from'./tracking.js';

describe('public token admission remains tied to public trading',()=>{
 it('combines the shared narrow token permission with a genuine confirmed public buy/sell',()=>{
  const sql=freshPublicTokenSql('token');
  expect(sql).toContain(freshTrackedTokenSql('token'));
  expect(sql).toContain(freshTrackedEventSql('visible_event','token'));
  expect(sql).toContain(GANG_TOKEN_ADDRESS);
  expect(sql).toContain('fresh.visible_trades visible_event');
  expect(sql).toContain('public_trade_kol.is_tracked');
  expect(sql).toContain('public_trade_scope.active');
  expect(sql).toContain('visible_event.wallet_address=ANY(public_trade_scope.wallet_addresses)');
  expect(sql).toContain('visible_event.block_number>=public_trade_scope.starts_block');
  expect(sql).toContain('visible_event.occurred_at>=public_trade_scope.starts_at');
  expect(sql).toContain("visible_event.kind IN('buy','sell')");
  expect(sql).toContain('visible_event.canonical');
  expect(sql).toContain("WHERE key='capture'");
  expect(sql).not.toContain("visible_event.kind IN('transfer_in'");
 });
 it('rejects untrusted SQL aliases before composing a query',()=>{
  expect(()=>freshPublicTokenSql('t;SELECT')).toThrow('Invalid SQL alias');
 });
});
