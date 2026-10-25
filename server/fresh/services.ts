import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';
import { createFreshReads } from './reads.js';
import { createFreshCharts } from './charts.js';
import { ChartDiskCache } from './cache.js';
import { createFreshReplay, type FreshReplayManifest } from './replay.js';
import { createGmgnRequester } from '../gmgnTransport.js';

export function createFreshServices(db:Pool) {
  const reads=createFreshReads(db);
  const cache=new ChartDiskCache(path.resolve(process.env.GMGN_CHART_CACHE_DIR??'.cache/fresh/charts'));
  const request=createGmgnRequester({query:(sql,values)=>db.query(sql,values),stateTable:'fresh.checkpoints'});
  const charts=createFreshCharts({cache,request});
  async function validateRevision(claims:FreshReplayManifest) {
    const row=(await db.query(`SELECT kind,account_id,revision::text,correction_epoch::text,wallet_addresses FROM fresh.accounting_scopes WHERE id=$1 AND active`,[claims.scopeId])).rows[0];
    if(!row||row.correction_epoch!==claims.correctionEpoch||!row.wallet_addresses.includes(claims.wallet))return false;
    if(row.kind==='kol')return claims.scope==='public'&&(await db.query(`SELECT 1 FROM fresh.kols WHERE wallet_address=$1 AND is_tracked`,[claims.wallet])).rowCount===1;
    if(claims.scope!==`account:${row.account_id}`||row.revision!==claims.membershipRevision)return false;
    return (await db.query(`SELECT 1 FROM journal_wallets WHERE user_id=$1::uuid AND wallet_address=$2`,[row.account_id,claims.wallet])).rowCount===1;
  }
  const replay=createFreshReplay({charts,secret:process.env.FRESH_REPLAY_SECRET??randomBytes(48),validateRevision});
  return {reads,charts,replay,cache,validateRevision};
}
export type FreshServices=ReturnType<typeof createFreshServices>;
