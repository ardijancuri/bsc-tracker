import {readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import type {Pool} from 'pg';

export async function freshFolderSize(directory:string):Promise<number>{
  let total=0;
  try{for(const item of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isFile())total+=(await stat(file)).size;else if(item.isDirectory())total+=await freshFolderSize(file);}}catch{}
  return total;
}
export async function freshStorageReport(db:Pool){
  const relations=(await db.query(`SELECT schemaname,tablename,pg_table_size(format('%I.%I',schemaname,tablename)::regclass)::text AS data_bytes,
    pg_indexes_size(format('%I.%I',schemaname,tablename)::regclass)::text AS index_bytes FROM pg_tables WHERE schemaname IN('fresh','public') ORDER BY schemaname,tablename`)).rows;
  const totals={permanentFinancialDataBytes:0,temporaryEvidenceDataBytes:0,currentIdentityAndFeatureDataBytes:0,indexBytes:0};
  for(const row of relations){const bytes=Number(row.data_bytes);totals.indexBytes+=Number(row.index_bytes);
    if(row.schemaname==='fresh'&&['financial_events','pending_trades','scope_event_results','positions','open_lots','accounting_scopes'].includes(row.tablename))totals.permanentFinancialDataBytes+=bytes;
    else if(row.schemaname==='fresh'&&['recent_blocks','recent_evidence'].includes(row.tablename))totals.temporaryEvidenceDataBytes+=bytes;
    else totals.currentIdentityAndFeatureDataBytes+=bytes;
  }
  const local=process.env.FRESH_LOCAL_ONLY==='true';
  return {at:new Date().toISOString(),databaseBytes:Number((await db.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes),
    tables:relations.length,...totals,chartCacheBytes:await freshFolderSize(path.resolve(process.env.GMGN_CHART_CACHE_DIR??'.cache/fresh/charts')),
    walBytes:local?await freshFolderSize(path.resolve('.cache/fresh/pg/pg_wal')):null,
    // Include timestamped ordinary-runtime logs as well as the older fixed
    // filenames. Private audit exports and database files are separate data.
    logBytes:local?await readdir('.cache/fresh',{withFileTypes:true}).then(entries=>Promise.all(entries.filter(e=>e.isFile()&&e.name.endsWith('.log')).map(async e=>(await stat(path.join('.cache/fresh',e.name))).size))).then(values=>values.reduce((sum,n)=>sum+n,0)):null,
    walScope:local?'shared_local_postgresql_cluster':null,
    relations};
}
