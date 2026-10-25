import{describe,it,expect}from'vitest';
import{runFreshBalanceSchedulingIntegration}from'./balanceScheduling.integration.js';
describe.skipIf(process.env.FRESH_BALANCE_SCHEDULING_PG_TEST!=='1')('balance scheduling on PostgreSQL',()=>{
 it('prioritizes ready work and retains strict public/Portfolio/canonical gates',async()=>{
  const report=await runFreshBalanceSchedulingIntegration();expect(report.ok).toBe(true);expect(report.checks.length).toBeGreaterThanOrEqual(10);expect(report.financialWrites).toBe(0);
 });
});
