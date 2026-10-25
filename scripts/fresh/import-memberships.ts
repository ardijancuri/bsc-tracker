import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pool,ensureSchema} from '../../server/db.js';
import {queueFreshRegistrationRepair} from '../../server/fresh/registration.js';
import {freshPortfolioScope,freshPortfolioAddress,freshPortfolioLabel} from '../../server/fresh/portfolio.js';

// Account membership metadata only. The old trading data is never read or
// imported. Restored monitoring is repaired from this new start block only.
const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!url.pathname.startsWith('/kollens_fresh_'))throw Error('Only the isolated fresh local database is allowed');
const filename=process.argv[2];if(!filename)throw Error('Supply an ignored membership metadata export');
const text=await readFile(filename,'utf8'),rows=JSON.parse(text);if(!Array.isArray(rows)||rows.length>10000)throw Error('Invalid membership export');
await ensureSchema();const client=await pool.connect();
try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(73621940)');
  const prior=(await client.query("SELECT 1 FROM fresh.checkpoints WHERE key='membership_import'")).rowCount;if(prior)throw Error('Membership metadata is already restored');
  const capture=(await client.query("SELECT * FROM fresh.checkpoints WHERE key='capture' FOR UPDATE")).rows[0];
  const start=(await client.query("SELECT * FROM fresh.checkpoints WHERE key='start'")).rows[0];if(!capture||!start)throw Error('Initialize tracking first');
  const fromBlock=Number(start.block_number)+1,startTime=start.value.startTime;
  let queued=0;const accounts=new Set<string>();
  for(const row of rows){
    const wallet=freshPortfolioAddress(row.wallet_address),label=freshPortfolioLabel(row.label),account=row.user_id;
    if(typeof account!=='string'||!(await client.query('SELECT 1 FROM auth_users WHERE id=$1',[account])).rowCount)throw Error('Membership account is unavailable');
    if(!Number.isFinite(Date.parse(row.added_at))||!Number.isFinite(Date.parse(row.activity_from))||typeof row.revision!=='string')throw Error('Invalid membership metadata');
    if(Date.parse(row.activity_from)>Date.parse(startTime))throw Error('Later membership requires its own confirmed registration checkpoint');
    const priorWallet=(await client.query('SELECT active,monitoring_from_block FROM fresh.wallets WHERE address=$1 FOR UPDATE',[wallet])).rows[0];
    await client.query(`INSERT INTO fresh.wallets(address,monitoring_from_block,registered_at) VALUES($1,$2,$3)
      ON CONFLICT(address) DO UPDATE SET active=true,monitoring_to_block=NULL,monitoring_from_block=least(fresh.wallets.monitoring_from_block,EXCLUDED.monitoring_from_block),revision=fresh.wallets.revision+1`,[wallet,fromBlock,startTime]);
    await client.query(`INSERT INTO public.journal_wallets(user_id,wallet_address,label,added_at,activity_from,revision,registration_block,registration_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[account,wallet,label,row.added_at,startTime,row.revision,fromBlock,start.block_hash]);
    await client.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,account_id,starts_at,starts_block) VALUES($1,'portfolio_wallet',$2,$3,$4,$5)`,[freshPortfolioScope(account,wallet),[wallet],account,startTime,fromBlock]);
    if(!priorWallet?.active||Number(priorWallet.monitoring_from_block)>fromBlock){const result=await queueFreshRegistrationRepair(client,{wallet,fromBlock,targetBlock:Number(capture.block_number),targetHash:capture.block_hash});if(result.queued)queued++;}
    accounts.add(account);
  }
  for(const account of accounts){const members=(await client.query('SELECT wallet_address FROM public.journal_wallets WHERE user_id=$1 ORDER BY wallet_address',[account])).rows;
    await client.query(`INSERT INTO fresh.accounting_scopes(id,kind,wallet_addresses,account_id,starts_at,starts_block) VALUES($1,'portfolio_combined',$2,$3,$4,$5)`,[freshPortfolioScope(account),members.map(row=>row.wallet_address),account,startTime,fromBlock]);}
  await client.query("UPDATE fresh.checkpoints SET revision=revision+1,updated_at=clock_timestamp() WHERE key='capture'");
  const report={at:new Date().toISOString(),memberships:rows.length,accounts:accounts.size,registrationRepairs:queued,financialRowsImported:0,sourceDigest:createHash('sha256').update(text).digest('hex')};
  await client.query("INSERT INTO fresh.checkpoints(key,value) VALUES('membership_import',$1::jsonb)",[JSON.stringify(report)]);await client.query('COMMIT');
  await writeFile('.cache/fresh/membership-preservation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
