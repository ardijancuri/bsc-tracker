// Creates only fresh, uniquely named disposable databases on local port 5435.
// Never points a destructive suite at the application's own database.
import pg from 'pg';
import {spawnSync} from 'node:child_process';
const source=new URL(process.env.DATABASE_URL);
if(!['localhost','127.0.0.1'].includes(source.hostname)||source.port!=='5435')throw Error('Disposable local PostgreSQL only');
const admin=new pg.Client({connectionString:source.href});await admin.connect();
const environment={...process.env,TELEGRAM_BOT_TOKEN:'',TELEGRAM_CLIENT_ID:'',TELEGRAM_CLIENT_SECRET:'',GMGN_API_KEY:'',GMGN_CHART_API_KEY:'',GMGN_ACCOUNTING_API_KEY:'',NODE_HISTORICAL_IMPORTS:'0'};
try {
  const evidence=spawnSync(process.execPath,['--import','tsx','server/nodeEvidence.integration.ts'],{env:environment,stdio:'inherit'});
  if(evidence.status!==0)throw Error('Evidence integration failed');
  const collection=spawnSync(process.execPath,['--import','tsx','server/journalCollection.integration.ts'],{env:environment,stdio:'inherit'});
  if(collection.status!==0)throw Error('Journal collection integration failed');
  for(const file of ['server/nodeHistoricalImportSchema.integration.ts','server/schemaStartup.integration.ts','server/nodeEvidenceMetadata.integration.ts','server/nodeTokenIdentity.integration.ts','server/nodeLeaderboard.integration.ts','server/nodeLeaderboardAccounting.integration.ts','server/nodeMarketThroughput.integration.ts']){
    const result=spawnSync(process.execPath,['--import','tsx',file],{env:environment,stdio:'inherit'});
    if(result.status!==0)throw Error(file+' failed');
  }
  for(const [prefix,file] of [
    ['bscan_node_market_test_','server/nodeMarket.integration.ts'],
    ['bscan_node_market_discovery_test_','server/nodeMarketDiscovery.integration.ts'],
    ['bscan_node_market_conversion_test_','server/nodeMarketConversion.integration.ts'],
    ['bscan_node_market_migration_test_','server/nodeMarketMigration.integration.ts'],
    ['bscan_node_import_test_','server/nodeHistoricalImport.integration.ts'],
    ['bscan_node_trace_test_','server/nodeTrace.integration.ts'],
    ['bscan_node_projection_test_','server/nodeTradeProjection.integration.ts'],
    ['bscan_node_accounting_test_','server/nodeAccounting.integration.ts'],
    ['bscan_journal_test_','server/journal.integration.ts'],
    ['bscan_intelligence_test_','server/kolProfile.integration.ts'],
    ['bscan_intelligence_test_','server/intelligence.integration.ts'],
    ['bscan_notifications_test_','server/telegramNotifications.integration.ts']
  ]){
    const name=prefix+Date.now()+String(Math.floor(Math.random()*1_000_000)).padStart(6,'0');
    if(!/^bscan_[a-z_]+_test_\d+$/.test(name))throw Error('Invalid disposable database');
    await admin.query('CREATE DATABASE "'+name+'"');
    try {
      const target=new URL(source);target.pathname='/'+name;
      const result=spawnSync(process.execPath,['--import','tsx',file],{env:{...environment,DATABASE_URL:target.href},stdio:'inherit'});
      if(result.status!==0)throw Error(file+' failed');
    }finally{await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');}
  }
  console.log('All twenty-one node-owned PostgreSQL integration suites passed; transports fake/disabled.');
}finally{await admin.end();}
