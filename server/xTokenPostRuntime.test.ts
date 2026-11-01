import {describe,it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import {createXTokenPostRuntime,runXTokenPostWorker,xTokenPostMode} from './xTokenPostRuntime.js';
import {rollbackXTokenPostsIfPresent} from './xTokenPostSchema.js';
const database=(ready=false)=>({query:vi.fn(async()=>({rows:[{ready}]}))} as unknown as Pool);

describe('Fresh X publisher integration',()=>{
 it('defaults to disabled and rejects an unknown publishing mode',()=>{
  expect(xTokenPostMode('disabled')).toBe('disabled');expect(()=>xTokenPostMode('on')).toThrow('invalid_x_token_post_mode');
 });
 it('disabled worker does not initialize tables, request credentials or start a runtime',async()=>{
  const db=database(),ensure=vi.fn(),runtime=vi.fn();
  await runXTokenPostWorker(db,undefined,{mode:'disabled',ensure,runtime});
  expect(ensure).not.toHaveBeenCalled();expect(runtime).not.toHaveBeenCalled();expect(db.query).not.toHaveBeenCalled();
 });
 it('an aborted worker never starts even in explicitly configured live mode',async()=>{
  const db=database(),ensure=vi.fn(),runtime=vi.fn();
  await runXTokenPostWorker(db,AbortSignal.abort(),{mode:'live',ensure,runtime});
  expect(ensure).not.toHaveBeenCalled();expect(runtime).not.toHaveBeenCalled();
 });
 it('dry-run has no HTTP transport and starts only after its separate X schema',async()=>{
  const db=database(),events:string[]=[],run=vi.fn(async()=>{events.push('run');});
  const ensure=vi.fn(async()=>{events.push('schema');});
  const runtime=vi.fn(()=>({run})) as unknown as typeof createXTokenPostRuntime;
  await runXTokenPostWorker(db,undefined,{mode:'dry_run',ensure,runtime});
  expect(runtime).toHaveBeenCalledWith(db,{mode:'dry_run',offline:true});expect(events).toEqual(['schema','run']);
 });
 it('uninitialized status is read-only and reports disabled without creating tables',async()=>{
  const db=database();const status=await createXTokenPostRuntime(db,{mode:'disabled'}).status();
  expect(status).toMatchObject({mode:'disabled',initialized:false,settings:{enabled:false},connection:null});
  expect(db.query).toHaveBeenCalledTimes(1);
 });
 it('disabled runtime refuses enable and delivery without acquiring credentials',async()=>{
  const db=database(),runtime=createXTokenPostRuntime(db,{mode:'disabled'});
  await expect(runtime.enable()).rejects.toThrow('x_live_transport_unavailable');expect(await runtime.deliverOne()).toBe(false);
  expect(db.query).not.toHaveBeenCalled();
 });
 it('unconfigured Fresh reorgs leave the database untouched by X setup',async()=>{
  const db=database();await rollbackXTokenPostsIfPresent(db,100);
  expect(db.query).toHaveBeenCalledTimes(1);expect(vi.mocked(db.query).mock.calls[0][0]).toContain('to_regclass');
 });
 it('configured Fresh reorgs invalidate X jobs while retaining publication evidence',async()=>{
  const db=database(true);await rollbackXTokenPostsIfPresent(db,100);
  expect(db.query).toHaveBeenCalledTimes(2);expect(vi.mocked(db.query).mock.calls[1][0]).toContain("WHEN status='sent' THEN 'sent'");
  expect(vi.mocked(db.query).mock.calls[1][1]).toEqual([100]);
 });
});
