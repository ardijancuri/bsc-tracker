import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';
import { createFreshReads } from './reads.js';
import { createFreshCharts } from './charts.js';
import { ChartDiskCache } from './cache.js';
import { createFreshReplay, type FreshReplayManifest } from './replay.js';
import { createGmgnRequester } from '../gmgnTransport.js';
import {freshPendingTradeScopeSql}from'./positionDependencies.js';
import {freshTrackedTokenSql,readFreshGangHistoryAdmission,GANG_TOKEN_ADDRESS}from'./tracking.js';
import{freshScopeTokenCaptureSql}from'./gangTokenCoverage.js';
import{chainRpc}from'../rpc.js';
import{freshPositionWalletGapSql}from'./positionGapCoverage.js';
import{createFreshLeaderboardReadCache}from'./leaderboardCache.js';

export function createFreshServices(db:Pool) {
  const leaderboardCache=createFreshLeaderboardReadCache();
  const reads=createFreshReads(db,Date.now,false,{estimateRpc:chainRpc,leaderboardCache});
  const cache=new ChartDiskCache(path.resolve(process.env.GMGN_CHART_CACHE_DIR??'.cache/fresh/charts'));
  const request=createGmgnRequester({query:(sql,values)=>db.query(sql,values),stateTable:'fresh.checkpoints'});
  const charts=createFreshCharts({cache,request});
  async function validateRevision(claims:FreshReplayManifest) {
    if(claims.cutoffBlock===null||!/^\d+$/.test(claims.cutoffBlock))return false;
    const row=(await db.query(`SELECT s.kind,s.account_id,s.revision::text,s.correction_epoch::text,s.wallet_addresses,s.starts_at
      FROM fresh.accounting_scopes s WHERE s.id=$1 AND s.active
      AND EXISTS(SELECT 1 FROM fresh.tokens t WHERE t.address=$2 AND ${freshTrackedTokenSql('t')})
      AND $3::bigint<=${freshScopeTokenCaptureSql('s','$2')}
      AND EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=$3 AND b.block_hash=$4)
      AND NOT ${freshPendingTradeScopeSql('s','$2','$3')}
      AND NOT ${freshPositionWalletGapSql('$3','$2')}`,[claims.scopeId,claims.token,claims.cutoffBlock,claims.cutoffHash])).rows[0];
    if(!row||row.correction_epoch!==claims.correctionEpoch||!row.wallet_addresses.includes(claims.wallet))return false;
    if(row.kind==='kol'){
      if(claims.historyPermissionDigest!==undefined){
        if(claims.token!==GANG_TOKEN_ADDRESS||!/^[0-9a-f]{64}$/.test(claims.historyPermissionDigest))return false;
        const history=await readFreshGangHistoryAdmission(db);if(!history||history.digest!==claims.historyPermissionDigest)return false;
      }else if(claims.token===GANG_TOKEN_ADDRESS&&Date.parse(claims.from)<new Date(row.starts_at).getTime())return false;
      return claims.scope==='public'&&(await db.query(`SELECT 1 FROM fresh.kols WHERE wallet_address=$1 AND is_tracked`,[claims.wallet])).rowCount===1;
    }
    if(claims.historyPermissionDigest!==undefined)return false;
    if(claims.scope!==`account:${row.account_id}`||row.revision!==claims.membershipRevision)return false;
    return (await db.query(`SELECT 1 FROM journal_wallets WHERE user_id=$1::uuid AND wallet_address=$2`,[row.account_id,claims.wallet])).rowCount===1;
  }
  const replay=createFreshReplay({charts,secret:process.env.FRESH_REPLAY_SECRET??randomBytes(48),validateRevision});
  return {reads,charts,replay,cache,validateRevision};
}
export type FreshServices=ReturnType<typeof createFreshServices>;
