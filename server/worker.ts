import {pool,ensureSchema} from './db.js';
import {chainRpc} from './rpc.js';
import {runFreshWorker} from './fresh/worker.js';
import {createTelegramNotifications} from './telegramNotifications.js';
await ensureSchema();
const controller=new AbortController();
for(const signal of ['SIGINT','SIGTERM']as const)process.once(signal,()=>controller.abort());
const alerts=createTelegramNotifications({db:pool,stateTable:'fresh.checkpoints'});
try{await Promise.all([runFreshWorker(pool,chainRpc,controller.signal),alerts.run(controller.signal)]);}finally{controller.abort();await pool.end();}
