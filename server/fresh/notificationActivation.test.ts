import {describe,it,expect} from 'vitest';
import{freshNotificationActivation,freshNotificationProductionPolicy}from'./notificationActivation.js';
const now=Date.parse('2026-10-24T12:00:00.000Z');
const valid=()=>({block_number:'123',block_hash:'0x'+'a'.repeat(64),capture_block:'125',current_hash:'0x'+'a'.repeat(64),
 activation:{version:1,activatedAt:new Date(now).toISOString(),alertStartBlock:'123',alertStartHash:'0x'+'a'.repeat(64),sourceManifestSha256:'b'.repeat(64)},
 seal:{version:1,sealedAt:new Date(now-1000).toISOString(),sourceManifestSha256:'b'.repeat(64),legacyPendingCount:0,legacyLeasedCount:0,legacySenderStoppedAcknowledged:true,
  legacyCollectorStoppedAcknowledged:true,legacyUnprocessedCount:0,legacyBotSendingCount:0,legacyHandoffBlock:'123',legacyHandoffHash:'0x'+'a'.repeat(64)}});
describe('Fresh production notification activation',()=>{
 it('requires an explicit production flag and does not change legacy/local behavior',()=>{
  expect(freshNotificationProductionPolicy('fresh.checkpoints','production',undefined)).toEqual({enabled:false});
  expect(freshNotificationProductionPolicy('fresh.checkpoints','production','true')).toEqual({enabled:true});
  expect(freshNotificationProductionPolicy('fresh.checkpoints','test','true')).toBeNull();
  expect(freshNotificationProductionPolicy('worker_state','production','true')).toBeNull();
 });
 it('accepts only a matching sealed canonical cutover',()=>expect(freshNotificationActivation(valid(),now)?.alertStartBlock).toBe('123'));
 it('blocks an absent activation or seal',()=>{
  expect(freshNotificationActivation(undefined,now)).toBeNull();const r=valid();r.seal=null as any;expect(freshNotificationActivation(r,now)).toBeNull();
 });
 for(const key of ['legacyPendingCount','legacyLeasedCount','legacyUnprocessedCount','legacyBotSendingCount']as const)it('blocks undrained '+key,()=>{const r=valid();r.seal[key]=1;expect(freshNotificationActivation(r,now)).toBeNull();});
 it('requires the old sender stop acknowledgement',()=>{const r=valid();r.seal.legacySenderStoppedAcknowledged=false;expect(freshNotificationActivation(r,now)).toBeNull();});
 it('requires the collector stop acknowledgement and exact sealed handoff',()=>{const r=valid();r.seal.legacyCollectorStoppedAcknowledged=false;expect(freshNotificationActivation(r,now)).toBeNull();const r2=valid();r2.seal.legacyHandoffBlock='124';expect(freshNotificationActivation(r2,now)).toBeNull();const r3=valid();r3.seal.legacyHandoffHash='0x'+'c'.repeat(64);expect(freshNotificationActivation(r3,now)).toBeNull();});
 it('rejects a different source export or orphaned activation block',()=>{
  const r=valid();r.seal.sourceManifestSha256='c'.repeat(64);expect(freshNotificationActivation(r,now)).toBeNull();
  const r2=valid();r2.current_hash='0x'+'d'.repeat(64);expect(freshNotificationActivation(r2,now)).toBeNull();
 });
 it('rejects inconsistent physical checkpoint fields and a future capture boundary',()=>{
  const r=valid();r.block_number='124';expect(freshNotificationActivation(r,now)).toBeNull();
  const r2=valid();r2.capture_block='122';expect(freshNotificationActivation(r2,now)).toBeNull();
 });
 it('keeps a verified old activation usable after bounded header expiry',()=>{const r=valid();r.current_hash=null as any;expect(freshNotificationActivation(r,now)).not.toBeNull();});
 it('rejects an invalidated or future activation',()=>{const r=valid();Object.assign(r.activation,{invalidatedAt:new Date(now).toISOString()});expect(freshNotificationActivation(r,now)).toBeNull();const r2=valid();r2.activation.activatedAt=new Date(now+5000).toISOString();expect(freshNotificationActivation(r2,now)).toBeNull();});
});
