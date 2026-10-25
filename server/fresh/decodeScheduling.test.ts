import{describe,it,expect}from'vitest';import{runFreshDecodeSchedulingIntegration}from'./decodeScheduling.integration.js';
// The default unit suite remains database-independent. The explicit guarded
// PostgreSQL run exercises actual SQL ordering instead of mocking its query.
describe.runIf(process.env.FRESH_SCHEDULING_PG_TEST==='1')('Fresh repair scheduling on real PostgreSQL',()=>{
 it('preserves fresh work and drains due repairs fairly without financial writes',async()=>{const r=await runFreshDecodeSchedulingIntegration();expect(r.ok).toBe(true);expect(r.checks).toHaveLength(10);expect(r.financialWrites).toBe(0);expect(r.originalFirstFailureUnchanged).toBe(true);},30000);
});
