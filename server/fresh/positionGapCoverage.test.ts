import{describe,it,expect}from'vitest';import{freshPositionWalletGapSql}from'./positionGapCoverage.js';
describe('position gap coverage query inputs',()=>{
 it.each(['0; DROP TABLE fresh.positions','untrusted','capture.block;select 1'])('rejects an unsafe cutoff %s',block=>expect(()=>freshPositionWalletGapSql(block)).toThrow('position_gap_block_invalid'));
 it('rejects unsafe token expressions',()=>expect(()=>freshPositionWalletGapSql('$1','p.token_address;select 1')).toThrow('pending_trade_sql_token_invalid'));
});
