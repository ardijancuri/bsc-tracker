import{Pool}from'pg';import{readFile}from'node:fs/promises';import{fileURLToPath}from'node:url';
import{chainRpc}from'./rpc.js';import{parseWpcRecoveryArgs,loadWpcRecoveryBundle,verifyWpcRecoveryCanonical,runWpcRecovery,wpcSha}from'./fresh/wpcRecoveryOperator.js';
const args=parseWpcRecoveryArgs(process.argv.slice(2));if(!process.env.DATABASE_URL)throw Error('wpc_recovery_database_required');
// Production is bundled; bind the actual dist-server executable, not a source
// tree or local runtime watermark that does not exist in the image.
const operatorSha=wpcSha(await readFile(fileURLToPath(import.meta.url))),bundle=await loadWpcRecoveryBundle(args.directory,args.manifestSha),pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
try{const capture=(await pool.query("SELECT revision::text FROM fresh.checkpoints WHERE key='capture'")).rows[0];if(!capture)throw Error('wpc_recovery_capture_missing');const canonical=await verifyWpcRecoveryCanonical(bundle,chainRpc,{captureRevision:String(capture.revision)});console.log(JSON.stringify(await runWpcRecovery(pool,bundle,canonical,operatorSha,{apply:args.apply,planDigest:args.planDigest})));}finally{await pool.end();}
