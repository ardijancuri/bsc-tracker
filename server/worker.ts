import {pool,ensureSchema} from './db.js';
import {chainRpc} from './rpc.js';
import {runFreshWorker} from './fresh/worker.js';
import {createTelegramNotifications} from './telegramNotifications.js';
import {runXTokenPostWorker} from './xTokenPostRuntime.js';
if(process.env.FRESH_WORKER_SCHEMA_READY==='true'){
  // An already-running app owns startup migrations for this release.
  // Keep worker-only rollouts out of the application-wide schema lock.
  const readiness=await pool.query("SELECT to_regclass('fresh.recent_evidence') AS evidence,to_regclass('fresh.jobs') AS jobs, EXISTS(SELECT 1 FROM fresh.checkpoints WHERE key='start') AS initialized");
  if(!readiness.rows[0]?.evidence||!readiness.rows[0]?.jobs||!readiness.rows[0]?.initialized)throw new Error('fresh_worker_schema_not_ready');
}else await ensureSchema();
const controller=new AbortController();
for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>controller.abort());
const alerts=createTelegramNotifications({db:pool,stateTable:'fresh.checkpoints'});
try{await Promise.all([runFreshWorker(pool,chainRpc,controller.signal),alerts.run(controller.signal),runXTokenPostWorker(pool,controller.signal)]);}finally{controller.abort();await pool.end();}
