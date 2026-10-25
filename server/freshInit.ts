import {pool,ensureSchema} from './db.js';
import {chainRpc} from './rpc.js';
import {initializeFreshTracking} from './fresh/bootstrap.js';
await ensureSchema();
try{console.log(JSON.stringify(await initializeFreshTracking(pool,chainRpc)));}finally{await pool.end();}
