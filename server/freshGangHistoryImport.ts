import {Pool} from 'pg';
import {chainRpc} from './rpc.js';
import {loadGangImportBundle,createGangImportArchiveRpc,verifyGangImportCanonical,runGangImport,parseGangImportArgs} from './fresh/gangHistoryImportOperator.js';

// Explicit one-time, checksum-pinned GANG import. Never starts the app, schema
// initializer, collector, provider financial lookup or notification transport.
const args=parseGangImportArgs(process.argv.slice(2));if(!process.env.DATABASE_URL)throw Error('gang_import_database_url_required');
const bundle=await loadGangImportBundle(args.directory,args.manifestSha),canonical=await verifyGangImportCanonical(bundle,chainRpc,createGangImportArchiveRpc());
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
try{console.log(JSON.stringify(await runGangImport(pool,bundle,canonical,{apply:args.apply,planDigest:args.planDigest})));}finally{await pool.end();}
