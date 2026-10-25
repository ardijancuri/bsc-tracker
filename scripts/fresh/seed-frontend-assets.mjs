import {constants} from 'node:fs';
import {lstat,realpath,readdir,open,mkdir,link,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_FILE=32*1024*1024,MAX_TOTAL=1024*1024*1024,MAX_FILES=10000;
const immutable=name=>/^[^/\\]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(name);
const need=(value,reason)=>{if(!value)throw Error(reason);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const within=(root,file)=>{const rel=path.relative(root,file);return!rel||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));};
const safeName=name=>name!=='.'&&name!=='..'&&!/[\x00-\x1f/\\]/.test(name);
const absent=error=>error?.code==='ENOENT';

async function info(file){try{return await lstat(file,{bigint:true});}catch(error){if(absent(error))return null;throw error;}}
async function directoryChain(directory){
  const root=path.parse(directory).root,relative=path.relative(root,directory);let current=root;
  for(const component of relative.split(path.sep).filter(Boolean)){
    need(safeName(component),'asset_path_component_invalid');current=path.join(current,component);
    const stat=await info(current);need(stat&&!stat.isSymbolicLink()&&stat.isDirectory(),'asset_directory_missing_or_symlink');
  }
  const resolved=await realpath(directory);need(samePath(resolved,path.resolve(directory)),'asset_directory_alias_forbidden');
}
async function checkedRoot(value){need(typeof value==='string'&&path.isAbsolute(value),'asset_absolute_path_required');need(!value.split(/[\\/]+/).includes('..'),'asset_path_escape');const root=path.resolve(value);await directoryChain(root);return root;}
const stable=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
async function fileDigest(file,{touch=false,target=false}={}){
  need(!touch||target,'asset_source_touch_forbidden');
  await directoryChain(path.dirname(file));const entry=await info(file);need(entry&&!entry.isSymbolicLink()&&entry.isFile(),'asset_regular_file_required');
  const handle=await open(file,(touch?constants.O_RDWR:constants.O_RDONLY)|(constants.O_NOFOLLOW??0));
  try{
    const before=await handle.stat({bigint:true});need(before.isFile()&&before.dev===entry.dev&&before.ino===entry.ino,'asset_file_changed');
    need(before.size<=BigInt(MAX_FILE),'asset_file_size_limit');if(target)need(before.nlink===1n,'asset_target_hardlink_forbidden');
    const sha=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let size=0;
    for(;;){const{bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;need(size<=MAX_FILE,'asset_file_size_limit');sha.update(buffer.subarray(0,bytesRead));}
    const after=await handle.stat({bigint:true}),current=await info(file);need(current&&!current.isSymbolicLink()&&stable(before,after)&&stable(after,current)&&BigInt(size)===before.size,'asset_file_changed');
    if(touch){const now=new Date();await handle.utimes(now,now);await handle.sync();}
    return{sha256:sha.digest('hex'),bytes:size};
  }finally{await handle.close();}
}
async function walk(root,visit,relative=''){
  const directory=path.join(root,relative);await directoryChain(directory);
  for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    need(safeName(entry.name),'asset_path_component_invalid');const rel=path.join(relative,entry.name),file=path.join(root,rel);need(within(root,file),'asset_path_escape');
    const stat=await info(file);need(stat&&!stat.isSymbolicLink(),'asset_symlink_forbidden');
    if(stat.isDirectory())await walk(root,visit,rel);else{need(stat.isFile(),'asset_regular_file_required');await visit(file,rel,entry.name);}
  }
}
async function ensureParents(root,relative){
  let current=root;await directoryChain(root);
  for(const component of path.dirname(relative).split(path.sep).filter(v=>v&&v!=='.')){
    need(safeName(component),'asset_path_component_invalid');current=path.join(current,component);need(within(root,current),'asset_path_escape');
    try{await mkdir(current);}catch(error){if(error.code!=='EEXIST')throw error;}
    await directoryChain(current);
  }
}

/** Read-only plan. Sources are asset roots: dist/assets or a retained cache,
 * never the entire dist directory. No shell, network, deletion or database IO. */
export async function planFrontendAssetSeed({sources,target}){
  need(Array.isArray(sources)&&sources.length>0&&sources.length<=8,'asset_sources_required');
  const roots=[];for(const source of sources)roots.push(await checkedRoot(source));const destination=await checkedRoot(target);
  need(!roots.some((root,i)=>roots.some((other,j)=>i!==j&&(within(root,other)||within(other,root)))),'asset_sources_overlap');
  need(!roots.some(root=>within(root,destination)||within(destination,root)),'asset_source_target_overlap');
  // Refuse even unrelated symlinks in the candidate cache. This operator is
  // run while the candidate API is stopped, on its new dedicated volume.
  await walk(destination,async()=>{});
  const files=new Map();let totalBytes=0;
  for(const root of roots)await walk(root,async(file,relative,name)=>{
    if(!immutable(name))return;const proof=await fileDigest(file),key=relative.split(path.sep).join('/'),existing=files.get(key);
    if(existing){need(existing.sha256===proof.sha256&&existing.bytes===proof.bytes,'asset_source_content_conflict:'+key);existing.sources.push(file);return;}
    totalBytes+=proof.bytes;need(totalBytes<=MAX_TOTAL&&files.size<MAX_FILES,'asset_seed_size_limit');
    const output=path.join(destination,relative),previous=await info(output);
    if(previous){const actual=await fileDigest(output,{target:true});need(actual.sha256===proof.sha256&&actual.bytes===proof.bytes,'asset_target_content_conflict:'+key);}
    files.set(key,{relative:key,...proof,sources:[file],exists:!!previous});
  });
  const entries=[...files.values()].sort((a,b)=>a.relative.localeCompare(b.relative));
  const manifest={version:1,sources:roots,target:destination,files:entries.map(({relative,bytes,sha256})=>({relative,bytes,sha256}))};
  return{...manifest,sha256:hash(JSON.stringify(manifest)),totalBytes,files:entries};
}

/** Digest-bound apply. Verified files are exclusively published through a
 * same-directory temporary inode; existing content is never overwritten. */
export async function applyFrontendAssetSeed({sources,target,expectedSha256,confirmTarget}){
  need(typeof expectedSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedSha256),'asset_plan_sha256_required');
  need(typeof confirmTarget==='string'&&path.isAbsolute(confirmTarget)&&samePath(path.resolve(confirmTarget),path.resolve(target)),'asset_target_confirmation_required');
  const plan=await planFrontendAssetSeed({sources,target});need(plan.sha256===expectedSha256,'asset_plan_changed');
  const lock=path.join(plan.target,'.kollens-asset-seed.lock');const lease=await open(lock,'wx',0o600);let copied=0,reused=0;
  try{
    for(const item of plan.files){
      for(const source of item.sources){const actual=await fileDigest(source);need(actual.sha256===item.sha256&&actual.bytes===item.bytes,'asset_source_changed:'+item.relative);}
      const relative=item.relative.split('/').join(path.sep),output=path.join(plan.target,relative);need(within(plan.target,output),'asset_path_escape');await ensureParents(plan.target,relative);
      const temporary=path.join(path.dirname(output),'.kollens-asset-seed-'+randomUUID()+'.tmp');let tempCreated=false;
      if(!await info(output)){
        try{
          const source=await open(item.sources[0],constants.O_RDONLY|(constants.O_NOFOLLOW??0));
          try{const temp=await open(temporary,'wx',0o644);tempCreated=true;
            try{const buffer=Buffer.allocUnsafe(1024*1024);let bytes=0;for(;;){const{bytesRead}=await source.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;need(bytes<=MAX_FILE,'asset_file_size_limit');let written=0;while(written<bytesRead){const result=await temp.write(buffer,written,bytesRead-written,null);need(result.bytesWritten>0,'asset_write_incomplete');written+=result.bytesWritten;}}await temp.sync();}
            finally{await temp.close();}
          }finally{await source.close();}
          const verified=await fileDigest(temporary);need(verified.sha256===item.sha256&&verified.bytes===item.bytes,'asset_copy_checksum_mismatch');await directoryChain(path.dirname(output));
          try{await link(temporary,output);copied++;}catch(error){if(error.code!=='EEXIST')throw error;reused++;}
        }finally{if(tempCreated)await unlink(temporary);}
      }else reused++;
      const verified=await fileDigest(output,{target:true});need(verified.sha256===item.sha256&&verified.bytes===item.bytes,'asset_target_content_conflict:'+item.relative);
      // Refresh verified destination retention only. Source mtimes are intact.
      const retained=await fileDigest(output,{touch:true,target:true});need(retained.sha256===item.sha256,'asset_target_changed');
    }
    return{ok:true,dryRun:false,sha256:plan.sha256,target:plan.target,files:plan.files.length,totalBytes:plan.totalBytes,copied,reused};
  }finally{await lease.close();await unlink(lock);}
}

export async function seedFrontendAssetsCli(args){
  const sources=[];let target,expectedSha256,confirmTarget,apply=false;
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(flag==='--apply'){need(!apply,'asset_duplicate_argument');apply=true;continue;}
    need(['--source','--target','--sha256','--confirm-target'].includes(flag)&&args[i+1]&&!args[i+1].startsWith('--'),'asset_argument_invalid');const value=args[++i];
    if(flag==='--source')sources.push(value);else if(flag==='--target'){need(!target,'asset_duplicate_argument');target=value;}else if(flag==='--sha256'){need(!expectedSha256,'asset_duplicate_argument');expectedSha256=value;}else{need(!confirmTarget,'asset_duplicate_argument');confirmTarget=value;}
  }
  if(apply)return applyFrontendAssetSeed({sources,target,expectedSha256,confirmTarget});
  need(!expectedSha256&&!confirmTarget,'asset_apply_arguments_without_apply');const plan=await planFrontendAssetSeed({sources,target});
  return{ok:true,dryRun:true,sha256:plan.sha256,target:plan.target,files:plan.files.length,totalBytes:plan.totalBytes,toCopy:plan.files.filter(f=>!f.exists).length,alreadyPresent:plan.files.filter(f=>f.exists).length,assets:plan.files.map(({relative,bytes,sha256})=>({relative,bytes,sha256}))};
}
if(process.argv[1]&&samePath(path.resolve(process.argv[1]),fileURLToPath(import.meta.url))){
  seedFrontendAssetsCli(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
}
