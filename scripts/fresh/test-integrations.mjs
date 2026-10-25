import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const cases=['accounting','schemaConcurrency','rolling','capture','decode','decodeBudget','isolatedIncoming','authenticityRepair','stateEvidence','recovery','notifications','portfolio','features','registration','artwork','vertical'];
await mkdir('.cache/fresh',{recursive:true});const results=[];
for(const name of cases){const started=Date.now(),child=spawn(process.execPath,['--env-file=.env','--import','tsx',`server/fresh/${name}.integration.ts`],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});
  const exitCode=await new Promise(resolve=>child.once('exit',resolve));results.push({name,exitCode,durationMs:Date.now()-started});
  if(exitCode!==0){await writeFile('.cache/fresh/integration-results.json',JSON.stringify({at:new Date().toISOString(),passed:false,results},null,2));process.exitCode=1;break;}}
if(!process.exitCode)await writeFile('.cache/fresh/integration-results.json',JSON.stringify({at:new Date().toISOString(),passed:true,results},null,2));
