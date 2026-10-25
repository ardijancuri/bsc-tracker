import {describe,expect,it} from 'vitest';
import {addFreshRollingContribution,emptyFreshRollingTotals,FRESH_ROLLING_WINDOW_MS,freshRollingTotalsFromRow,freshRollingWindow} from './rolling.js';
import {applyFreshEvent} from './accounting.js';
import type {FreshFinancialEvent,FreshScope} from '../../shared/freshAccounting.js';

describe('stored rolling KOL contribution projection',()=>{
  it('uses exact elapsed 24 hours across UTC midnight and timezone changes',()=>{
    expect(freshRollingWindow('2026-10-24T00:00:00Z')).toEqual({from:'2026-10-23T00:00:00.000Z',to:'2026-10-24T00:00:00.000Z'});
    const winter=freshRollingWindow('2026-10-25T02:30:00+01:00');
    expect(Date.parse(winter.to)-Date.parse(winter.from)).toBe(FRESH_ROLLING_WINDOW_MS);
    expect(()=>freshRollingWindow('invalid')).toThrow('invalid_rolling_time');
  });
  it('adds precomputed exact FIFO results and removes precisely the same contribution',()=>{
    const row={kind:'sell',realized_q:'1/3',known_realized_q:'1/3',capital_q:'20/3',volume_q:'7',trade_count:1};
    const once=addFreshRollingContribution(emptyFreshRollingTotals(),row);
    expect(once).toMatchObject({realized_q:'1/3',capital_q:'20/3',volume_q:'7',trade_count:1,sell_count:1,valued_sell_count:1});
    expect(addFreshRollingContribution(once,row,-1)).toEqual(emptyFreshRollingTotals());
  });
  it('never promotes known partial profit while an unknown realized result remains',()=>{
    let totals=addFreshRollingContribution(emptyFreshRollingTotals(),{kind:'sell',realized_q:'10',known_realized_q:'10',trade_count:1});
    const unknown={kind:'sell',realized_q:null,known_realized_q:'0',trade_count:1};
    totals=addFreshRollingContribution(totals,unknown);
    expect(totals).toMatchObject({realized_q:null,known_realized_q:'10',unknown_count:1,valued_sell_count:1,unknown_sell_count:1});
    expect(addFreshRollingContribution(totals,unknown,-1)).toMatchObject({realized_q:'10',unknown_count:0,unknown_sell_count:0});
  });
  it('keeps eligible fee and transfer contributions distinct from policy-excluded gas',()=>{
    let totals=addFreshRollingContribution(emptyFreshRollingTotals(),{kind:'fee',realized_q:'-1/4',known_realized_q:'-1/4',fee_q:'1/4'});
    totals=addFreshRollingContribution(totals,{kind:'transfer_out',realized_q:'2',known_realized_q:'2'});
    totals=addFreshRollingContribution(totals,{is_excluded_fee:true,fee_usd:'100',fee_attribution:{status:'unattributed'}});
    expect(totals).toMatchObject({realized_q:'7/4',valued_fee_count:1,valued_transfer_count:1,fee_only_q:'1/4',unallocated_fee_q:'100',unattributed_fee_count:1,unknown_count:0});
  });
  it('retains unknown excluded gas explicitly without treating it as zero known gas',()=>{
    const totals=addFreshRollingContribution(emptyFreshRollingTotals(),{is_excluded_fee:true,fee_usd:null,fee_attribution:{status:'excluded'}});
    expect(totals).toMatchObject({unallocated_fee_count:1,unallocated_fee_unknown_count:1,unattributed_fee_count:0,realized_q:'0'});
  });
  it('refuses counter underflow instead of hiding duplicate expiry',()=>{
    expect(()=>addFreshRollingContribution(emptyFreshRollingTotals(),{kind:'sell',realized_q:'1',known_realized_q:'1',trade_count:1},-1)).toThrow('rolling_negative_counter');
  });
  it('derives nullable realized total from persisted known total and unknown count',()=>{
    expect(freshRollingTotalsFromRow({rolling_known_realized_q:'2/3',rolling_unknown_count:1,rolling_realized_q:'999'})).toMatchObject({realized_q:null,known_realized_q:'2/3'});
    expect(freshRollingTotalsFromRow({rolling_known_realized_q:'2/3',rolling_unknown_count:0})).toMatchObject({realized_q:'2/3'});
  });
  it('retains unknown transfer basis so a later sale cannot manufacture a zero-cost profit',()=>{
    const wallet='0x'+'1'.repeat(40),token='0x'+'2'.repeat(40);
    const scope:FreshScope={id:'kol:'+wallet,kind:'kol',walletAddresses:[wallet],accountId:null,startsAt:'2026-10-20T00:00:00Z',startsBlock:'1',revision:'1'};
    const incoming:FreshFinancialEvent={id:'in',executionKey:'in',walletAddress:wallet,tokenAddress:token,kind:'transfer_in',quantity:'10',amountUsd:null,feeUsd:'0',feeKey:null,counterparty:'0x'+'3'.repeat(40),transferKey:null,blockNumber:'2',blockHash:'0x'+'a'.repeat(64),transactionHash:'0x'+'b'.repeat(64),transactionIndex:0,executionIndex:0,logIndex:0,occurredAt:'2026-10-21T00:00:00Z'};
    const opening=applyFreshEvent(scope,incoming,{position:null,lots:[]});
    expect(opening.result.realizedQ).toBe('0');expect(opening.lots[0].costQ).toBeNull();
    const sold=applyFreshEvent(scope,{...incoming,id:'sale',executionKey:'sale',kind:'sell',counterparty:null,amountUsd:'100',blockNumber:'3',occurredAt:'2026-10-24T00:00:00Z'},opening);
    expect(sold.result.realizedQ).toBeNull();
    const totals=addFreshRollingContribution(emptyFreshRollingTotals(),{kind:'sell',realized_q:sold.result.realizedQ,known_realized_q:sold.result.knownRealizedQ,trade_count:1});
    expect(totals).toMatchObject({realized_q:null,unknown_count:1,unknown_sell_count:1});
  });
});
