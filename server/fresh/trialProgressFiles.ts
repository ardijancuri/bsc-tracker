import {readFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

/** Local validation reports only. Never writes application financial storage. */
export async function writeFreshTrialJson(filename:string,value:unknown) {
  await mkdir(path.dirname(filename),{recursive:true});
  const temporary=filename+'.'+randomUUID()+'.tmp';
  try {
    const handle=await open(temporary,'wx');
    try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
    await rename(temporary,filename);
  }catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
export async function readFreshTrialJson<T=any>(filename:string):Promise<T> {return JSON.parse(await readFile(filename,'utf8'));}

export function assertFreshTrialMonitorStopped(pid:unknown,probe:(pid:number)=>unknown=pid=>process.kill(pid,0)){
  if(pid===null||pid===undefined)return;
  if(typeof pid!=='number'||!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid recorded trial monitor PID');
  try{probe(pid);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}
  throw Error('Stop the task-owned trial monitor before applying a review or starting another monitor');
}

/** Serialize reviewed state replacement and monitor startup. Stale locks are
 * deliberately not removed automatically; a crashed owner needs inspection. */
export async function withFreshTrialControlLock<T>(directory:string,work:()=>Promise<T>):Promise<T>{
  await mkdir(directory,{recursive:true});
  const filename=path.join(directory,'control.lock');
  const handle=await open(filename,'wx');
  try{await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await handle.sync();return await work();}
  finally{await handle.close();await unlink(filename);}
}
