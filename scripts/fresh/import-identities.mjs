import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';

// This importer cannot copy trades, accounting, quotes, candles or raw evidence.
// Obtain a read-only identity export separately. The source is never mutated.
export const identityTables=['auth_users','watch_sessions','watch_entries','account_watch_entries',
  'creator_claims','creator_profiles','auth_telegram_avatars','telegram_notification_settings',
  'telegram_kol_notification_settings','telegram_trade_events','telegram_notification_outbox',
  'telegram_notification_items','telegram_notification_updates','telegram_notification_pacing'];
function value(input){if(typeof input==='string'&&/^\\x[0-9a-f]*$/i.test(input))return Buffer.from(input.slice(2),'hex');
  if(input!==null&&typeof input==='object')return JSON.stringify(input);return input;}
export async function importIdentities(db,document){
  if(document.version!==1||!document.tables||!Array.isArray(document.kols))throw Error('Invalid identity export');
  const client=await db.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621940)');
    if((await client.query(`SELECT 1 FROM auth_users LIMIT 1`)).rowCount)throw Error('Identity import requires empty account storage');
    const boundary=(await client.query(`SELECT block_number::text,block_hash,value FROM fresh.checkpoints WHERE key='start'`)).rows[0];if(!boundary)throw Error('Initialize tracking first');
    for(const kol of document.kols){await client.query(`INSERT INTO fresh.wallets(address,monitoring_from_block,registered_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[kol.address,BigInt(boundary.block_number)+1n,boundary.value.startTime]);
      await client.query(`INSERT INTO fresh.kols(wallet_address,display_name,avatar_url,twitter,source,is_tracked) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(wallet_address) DO UPDATE SET display_name=EXCLUDED.display_name,avatar_url=EXCLUDED.avatar_url,twitter=EXCLUDED.twitter,is_tracked=EXCLUDED.is_tracked`,[kol.address,kol.display_name,kol.avatar_url,kol.twitter,kol.source,kol.is_tracked]);}
    for(const table of identityTables){const rows=document.tables[table]??[];if(!Array.isArray(rows))throw Error('Invalid identity rows');
      const actual=(await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,[table])).rows.map(row=>row.column_name);
      for(const row of rows){const keys=Object.keys(row).filter(key=>actual.includes(key));if(!keys.length)continue;
        await client.query(`INSERT INTO public.${table}(${keys.map(key=>`"${key}"`).join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(key=>value(row[key])));}
    }
    const accounts=document.tables.auth_users??[],report={version:1,sourceAt:document.at,importedAt:new Date().toISOString(),
      sourceDigest:createHash('sha256').update(JSON.stringify(document)).digest('hex'),counts:Object.fromEntries(identityTables.map(t=>[t,(document.tables[t]??[]).length])),
      kols:document.kols.length,accounts:accounts.length,financialRowsImported:0};
    await client.query(`INSERT INTO fresh.checkpoints(key,value) VALUES('identity_import',$1::jsonb)`,[JSON.stringify(report)]);
    await client.query('COMMIT');return report;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
if(process.argv[1]?.endsWith('import-identities.mjs')){
  const input=process.argv[2],destination=new URL(process.env.DATABASE_URL??'');
  if(!input||!['127.0.0.1','localhost'].includes(destination.hostname)||destination.port!=='5436'||!destination.pathname.startsWith('/kollens_fresh_'))throw Error('Only a fresh isolated local destination is allowed');
  const db=new pg.Pool({connectionString:destination.href});
  try{const report=await importIdentities(db,JSON.parse(await readFile(input,'utf8')));await writeFile('.cache/fresh/identity-preservation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}finally{await db.end();}
}
