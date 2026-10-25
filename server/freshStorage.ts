import {pool} from './db.js';
import {freshStorageReport} from './fresh/storage.js';
try{
  console.log(JSON.stringify(await freshStorageReport(pool),null,2));
}finally{await pool.end();}
