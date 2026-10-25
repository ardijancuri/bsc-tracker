import{describe,it,expect}from'vitest';import{createHash}from'node:crypto';
import{FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE,verifyFreshTrialFinancialRuntimeBinding,verifyFreshTrialRuntimeSourceProof,freshTrialMonitorSource,type FreshTrialFinancialRuntimeBinding,type FreshTrialSourceHash}from'./trialRuntimeBinding.js';
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
function fixture(){const files:FreshTrialSourceHash[]=[{path:'server/fresh/trialValidation.ts',sha256:'a'.repeat(64)},{path:'server/freshTrial.ts',sha256:'a'.repeat(64)},
 ...Array.from({length:100},(_v,i)=>({path:`server/fresh/financial${i}.ts`,sha256:'a'.repeat(64)}))];
 const bytes=Buffer.from(JSON.stringify({sourceDigest:FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE,files}));
 const binding:FreshTrialFinancialRuntimeBinding={version:1,baselinePath:'.cache/fresh/private/forward-validation-20261024/before-source.json',sha256:sha(bytes),runtimeSourceDigest:FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE};return{files,bytes,binding};}
describe('unchanged financial runtime binding for monitor-only validation updates',()=>{
 it('pins all102 original files and permits only monitor edits/additions',()=>{const f=fixture(),current=structuredClone(f.files);current[0].sha256='b'.repeat(64);current.push({path:'server/fresh/trialRuntimeBinding.ts',sha256:'c'.repeat(64)});
  const proof=verifyFreshTrialRuntimeSourceProof(f.binding,f.bytes,current);expect(proof.runtimeSourceDigest).toBe(FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE);expect(proof.baselineFiles).toBe(102);expect(proof.monitorChanges).toEqual(['server/fresh/trialValidation.ts']);expect(proof.monitorAdditions).toEqual(['server/fresh/trialRuntimeBinding.ts']);});
 it('rejects changed financial values, newly added nonmonitor files, and removed original files',()=>{const f=fixture();let current=structuredClone(f.files);current[2].sha256='b'.repeat(64);expect(()=>verifyFreshTrialRuntimeSourceProof(f.binding,f.bytes,current)).toThrow('source_changed');
  current=structuredClone(f.files);current.push({path:'server/fresh/newPricing.ts',sha256:'b'.repeat(64)});expect(()=>verifyFreshTrialRuntimeSourceProof(f.binding,f.bytes,current)).toThrow('source_added');
  expect(()=>verifyFreshTrialRuntimeSourceProof(f.binding,f.bytes,f.files.slice(1))).toThrow('source_missing');});
 it('rejects unpinned/corrupt source artifacts and any replacement runtime digest',()=>{const f=fixture();expect(()=>verifyFreshTrialRuntimeSourceProof({...f.binding,sha256:'b'.repeat(64)},f.bytes,f.files)).toThrow('baseline_invalid');
  expect(()=>verifyFreshTrialRuntimeSourceProof({...f.binding,runtimeSourceDigest:'b'.repeat(64)},f.bytes,f.files)).toThrow('baseline_invalid');
  const changed=Buffer.from(JSON.stringify({sourceDigest:FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE,files:f.files.slice(1)}));expect(()=>verifyFreshTrialRuntimeSourceProof({...f.binding,sha256:sha(changed)},changed,f.files)).toThrow('baseline_invalid');});
 it('rejects duplicate/traversal path inventories and financial-looking monitor path escapes',()=>{const f=fixture();expect(()=>verifyFreshTrialRuntimeSourceProof(f.binding,f.bytes,[...f.files,f.files[0]])).toThrow('inventory_invalid');
  expect(freshTrialMonitorSource('server/fresh/trial/../pricing.ts')).toBe(false);expect(freshTrialMonitorSource('server/fresh/TrialPricing.ts')).toBe(false);expect(freshTrialMonitorSource('server/fresh/trialRuntimeBinding.ts')).toBe(true);
  const current=structuredClone(f.files);current[2].path='server/fresh/../pricing.ts';expect(()=>verifyFreshTrialRuntimeSourceProof(f.binding,f.bytes,current)).toThrow('inventory_invalid');});
 it('never allows a newly self-hashed replacement artifact to impersonate the approved financial baseline',async()=>{const f=fixture();await expect(verifyFreshTrialFinancialRuntimeBinding(f.binding)).rejects.toThrow('baseline_unapproved');});
});
