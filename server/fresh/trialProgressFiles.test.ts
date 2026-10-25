import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {it,expect} from 'vitest';
import {readFreshTrialJson,writeFreshTrialJson,withFreshTrialControlLock,assertFreshTrialMonitorStopped} from './trialProgressFiles.js';
it('atomically replaces progress while retaining the exact complete JSON payload',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'fresh-trial-progress-'));
  try{const file=path.join(directory,'nested','state.json');
    await writeFreshTrialJson(file,{verifiedSeconds:60,segments:['first']});
    expect(await readFreshTrialJson(file)).toEqual({verifiedSeconds:60,segments:['first']});
    await writeFreshTrialJson(file,{verifiedSeconds:120,segments:['first','next']});
    expect(JSON.parse(await readFile(file,'utf8'))).toEqual({verifiedSeconds:120,segments:['first','next']});
    expect(await readdir(path.dirname(file))).toEqual(['state.json']);
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('rejects duplicate live monitors and uncertain ownership while allowing verified stopped owners',()=>{
  expect(()=>assertFreshTrialMonitorStopped(42,()=>true)).toThrow('Stop the task-owned trial monitor');
  expect(()=>assertFreshTrialMonitorStopped(42,()=>{throw Object.assign(Error('gone'),{code:'ESRCH'});})).not.toThrow();
  expect(()=>assertFreshTrialMonitorStopped(42,()=>{throw Object.assign(Error('unknown'),{code:'EPERM'});})).toThrow('unknown');
  expect(()=>assertFreshTrialMonitorStopped(null,()=>{throw Error('not called');})).not.toThrow();
  expect(()=>assertFreshTrialMonitorStopped(-1)).toThrow('Invalid');
});
it('serializes reviews/startup and releases the control lock after a failure',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'fresh-trial-lock-'));
  try{
    await withFreshTrialControlLock(directory,async()=>{
      await expect(withFreshTrialControlLock(directory,async()=>null)).rejects.toMatchObject({code:'EEXIST'});
      expect(JSON.parse(await readFile(path.join(directory,'control.lock'),'utf8')).pid).toBe(process.pid);
    });
    await expect(withFreshTrialControlLock(directory,async()=>{throw Error('review failed');})).rejects.toThrow('review failed');
    expect(await withFreshTrialControlLock(directory,async()=>42)).toBe(42);
    expect(await readdir(directory)).toEqual([]);
  }finally{await rm(directory,{recursive:true,force:true});}
});
