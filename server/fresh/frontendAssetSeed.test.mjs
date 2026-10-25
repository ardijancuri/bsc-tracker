import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,utimes,symlink,link,truncate,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {spawnSync}from'node:child_process';
import Fastify from 'fastify';
import {planFrontendAssetSeed,applyFrontendAssetSeed,seedFrontendAssetsCli}from'../../scripts/fresh/seed-frontend-assets.mjs';
import {registerFrontendRoutes}from'../frontendRoutes.js';

let fixture,legacyCache,legacyDist,candidateDist,target,sources;
const oldName='OldModal-1234abcd.js',dependency='OldChart-2345bcde.js',css='OldChart-3456cdef.css',font='manrope-4567defg.woff2',currentName='CurrentModal-5678efgh.js';
beforeEach(async()=>{
 fixture=await mkdtemp(path.join(os.tmpdir(),'fresh-frontend-seed-'));legacyCache=path.join(fixture,'legacy-cache');legacyDist=path.join(fixture,'legacy-dist');candidateDist=path.join(fixture,'candidate-dist');target=path.join(fixture,'new-cache');
 for(const dir of[legacyCache,path.join(legacyDist,'assets'),path.join(candidateDist,'assets'),target])await mkdir(dir,{recursive:true});sources=[legacyCache,path.join(legacyDist,'assets'),path.join(candidateDist,'assets')];
 await writeFile(path.join(legacyCache,dependency),'export const oldDependency=true;');await writeFile(path.join(legacyCache,css),'.old{color:yellow}');
 await writeFile(path.join(legacyDist,'assets',oldName),`import './${dependency}';export const old=true;`);await writeFile(path.join(legacyDist,'assets',font),Buffer.from([1,2,3,4]));
 await writeFile(path.join(candidateDist,'assets',currentName),'export const current=true;');await writeFile(path.join(candidateDist,'index.html'),'<html>new application</html>');
});
afterEach(async()=>{if(fixture){expect(path.dirname(path.resolve(fixture))).toBe(path.resolve(os.tmpdir()));expect(path.basename(fixture)).toMatch(/^fresh-frontend-seed-/);await rm(fixture,{recursive:true,force:true});}});
const apply=async()=>{const plan=await planFrontendAssetSeed({sources,target});return applyFrontendAssetSeed({sources,target,expectedSha256:plan.sha256,confirmTarget:target});};

describe('guarded frontend cache seed',()=>{
 it('defaults to a read-only plan combining old dist/cache and candidate assets',async()=>{
  await writeFile(path.join(legacyCache,'settings.json'),'not a hashed asset');const before=await stat(path.join(legacyCache,dependency));
  const result=await seedFrontendAssetsCli(sources.flatMap(s=>['--source',s]).concat(['--target',target]));
  expect(result).toMatchObject({dryRun:true,files:5,toCopy:5,alreadyPresent:0});expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);expect(await readdir(target)).toEqual([]);
  expect((await stat(path.join(legacyCache,dependency))).mtimeMs).toBe(before.mtimeMs);
 });
 it('publishes verified copies, refreshes only target retention, and is idempotent',async()=>{
  const oldDate=new Date(Date.now()-9*24*60*60*1000);await utimes(path.join(legacyCache,dependency),oldDate,oldDate);await writeFile(path.join(target,dependency),await readFile(path.join(legacyCache,dependency)));await utimes(path.join(target,dependency),oldDate,oldDate);
  const source=await stat(path.join(legacyCache,dependency)),existing=await stat(path.join(target,dependency));const result=await apply();
  expect(result).toMatchObject({dryRun:false,files:5,copied:4,reused:1});expect((await stat(path.join(target,dependency))).ino).toBe(existing.ino);expect((await stat(path.join(target,dependency))).mtimeMs).toBeGreaterThan(Date.now()-10000);
  expect((await stat(path.join(legacyCache,dependency))).mtimeMs).toBe(source.mtimeMs);for(const name of[oldName,dependency,css,font,currentName])expect(await readFile(path.join(target,name))).toEqual(await readFile(path.join(name===currentName?candidateDist:legacyDist,'assets',name)).catch(()=>readFile(path.join(legacyCache,name))));
  expect(await apply()).toMatchObject({copied:0,reused:5});expect((await readdir(target)).some(n=>n.startsWith('.kollens-'))).toBe(false);
 });
 it('deduplicates identical sources but refuses a same-path content conflict before writing',async()=>{
  await writeFile(path.join(candidateDist,'assets',dependency),await readFile(path.join(legacyCache,dependency)));expect((await planFrontendAssetSeed({sources,target})).files).toHaveLength(5);
  await writeFile(path.join(candidateDist,'assets',dependency),'different content');await expect(apply()).rejects.toThrow('asset_source_content_conflict');expect(await readdir(target)).toEqual([]);
 });
 it('never overwrites a conflicting existing target',async()=>{
  await writeFile(path.join(target,oldName),'preserve me');const before=await stat(path.join(target,oldName));await expect(apply()).rejects.toThrow('asset_target_content_conflict');expect(await readFile(path.join(target,oldName),'utf8')).toBe('preserve me');expect((await stat(path.join(target,oldName))).mtimeMs).toBe(before.mtimeMs);expect(await readdir(target)).toEqual([oldName]);
 });
 it('requires a matching digest and explicit target confirmation for apply',async()=>{
  const plan=await planFrontendAssetSeed({sources,target});await expect(applyFrontendAssetSeed({sources,target,expectedSha256:plan.sha256,confirmTarget:legacyCache})).rejects.toThrow('asset_target_confirmation_required');
  await writeFile(path.join(candidateDist,'assets',currentName),'changed after review');await expect(applyFrontendAssetSeed({sources,target,expectedSha256:plan.sha256,confirmTarget:target})).rejects.toThrow('asset_plan_changed');expect(await readdir(target)).toEqual([]);
  await expect(seedFrontendAssetsCli(['--source',legacyCache,'--target',target,'--apply'])).rejects.toThrow('asset_plan_sha256_required');
 });
 it('refuses relative paths, path traversal and overlapping source/target roots',async()=>{
  await expect(planFrontendAssetSeed({sources:['relative'],target})).rejects.toThrow('asset_absolute_path_required');await expect(planFrontendAssetSeed({sources:[path.join(legacyCache,'..','legacy-cache')+path.sep+'..'+path.sep+'legacy-cache'],target})).rejects.toThrow('asset_path_escape');
  await expect(planFrontendAssetSeed({sources:[legacyCache],target:legacyCache})).rejects.toThrow('asset_source_target_overlap');await expect(planFrontendAssetSeed({sources:[legacyDist,path.join(legacyDist,'assets')],target})).rejects.toThrow('asset_sources_overlap');
 });
 it.each(['source-child','source-root','target-child','target-root'])('refuses a symlink at %s',async place=>{
  const outside=path.join(fixture,'outside');await mkdir(outside);await writeFile(path.join(outside,'Outside-1234abcd.js'),'outside');const type=process.platform==='win32'?'junction':'dir';
  if(place==='source-child')await symlink(outside,path.join(legacyCache,'linked'),type);
  if(place==='target-child')await symlink(outside,path.join(target,'linked'),type);
  if(place==='source-root'){const alias=path.join(fixture,'source-link');await symlink(legacyCache,alias,type);sources=[alias];}
  if(place==='target-root'){const alias=path.join(fixture,'target-link');await symlink(target,alias,type);target=alias;}
  await expect(planFrontendAssetSeed({sources,target})).rejects.toThrow(/symlink|alias/);expect(await readFile(path.join(outside,'Outside-1234abcd.js'),'utf8')).toBe('outside');
 });
 it('refuses a target hardlink so retention cannot modify a source inode',async()=>{
  await link(path.join(legacyCache,dependency),path.join(target,dependency));const before=await stat(path.join(legacyCache,dependency));await expect(apply()).rejects.toThrow('asset_target_hardlink_forbidden');expect((await stat(path.join(legacyCache,dependency))).mtimeMs).toBe(before.mtimeMs);
 });
 it('runs the real CLI as a dry run without an apply flag',()=>{
  const run=spawnSync(process.execPath,['scripts/fresh/seed-frontend-assets.mjs','--source',legacyCache,'--target',target],{cwd:process.cwd(),encoding:'utf8'});expect(run.status).toBe(0);expect(JSON.parse(run.stdout)).toMatchObject({dryRun:true,files:2});
 });
 it('retains nested immutable paths and bounds oversized files before copying',async()=>{
  await mkdir(path.join(legacyCache,'nested'));await writeFile(path.join(legacyCache,'nested','Dependency-1234abcd.js'),'nested dependency');await apply();expect(await readFile(path.join(target,'nested','Dependency-1234abcd.js'),'utf8')).toBe('nested dependency');
  const huge=path.join(legacyCache,'Oversized-2345bcde.js');await writeFile(huge,'');await truncate(huge,33*1024*1024);await expect(planFrontendAssetSeed({sources,target})).rejects.toThrow('asset_file_size_limit');await expect(stat(path.join(target,'Oversized-2345bcde.js'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('does not remove an existing operator lock or start a second writer',async()=>{
  await writeFile(path.join(target,'.kollens-asset-seed.lock'),'existing owner');await expect(apply()).rejects.toMatchObject({code:'EEXIST'});expect(await readFile(path.join(target,'.kollens-asset-seed.lock'),'utf8')).toBe('existing owner');expect(await readdir(target)).toEqual(['.kollens-asset-seed.lock']);
 });
 it('keeps old lazy imports, dependencies, styles and fonts available after the real frontend registration',async()=>{
  const oldDate=new Date(Date.now()-9*24*60*60*1000);await writeFile(path.join(target,dependency),await readFile(path.join(legacyCache,dependency)));await utimes(path.join(target,dependency),oldDate,oldDate);await apply();
  const app=Fastify();try{await registerFrontendRoutes(app,candidateDist,target);await app.ready();for(const name of[oldName,dependency,css,font,currentName]){const r=await app.inject('/assets/'+name);expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');}
   expect((await app.inject('/assets/Absent-1234abcd.js')).statusCode).toBe(404);expect((await app.inject('/tokens')).body).toContain('new application');
  }finally{await app.close();}
 });
});
