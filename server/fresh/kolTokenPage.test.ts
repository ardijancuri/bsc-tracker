import{describe,it,expect}from'vitest';
import{freshPublicKolTokenPageSql}from'./kolTokenPage.js';
import{freshPublicTradeScopeSql}from'./publicTokens.js';
import{freshTrackedEventSql,freshTrackedTokenSql}from'./tracking.js';
import{kolProfileTokenSql}from'../kolProfileToken.js';
describe('wallet token pages use one shared visibility-qualified ID set',()=>{
 it('retains actual trade visibility, complete public boundary/capture checks and token exclusions before pagination',()=>{const sql=freshPublicKolTokenPageSql();expect(sql).toContain(freshPublicTradeScopeSql('e'));expect(sql).toContain(freshTrackedEventSql('e','wallet_token'));expect(sql).toContain(freshTrackedTokenSql('t'));expect(sql).toContain(kolProfileTokenSql('t'));expect(sql).toContain('SELECT DISTINCT e.token_address');expect(sql.indexOf('SELECT DISTINCT')).toBeLessThan(sql.indexOf('LIMIT $2'));expect(sql).toContain('ORDER BY t.last_trade_at DESC NULLS LAST,t.address LIMIT $2 OFFSET $3');expect(sql).toContain('e.wallet_address=$1');expect(sql).not.toContain('fresh.open_lots');expect(sql).not.toContain('fresh.positions');});
});
