import{describe,it,expect}from'vitest';
import{applyFreshEvent,freshEventFromRow,freshFinancialBasis,freshAirdropBasisKey,validFreshAirdropBasis,validateFreshFinancialEvent,assertFreshEventQuoteCompatible,freshCostOnlyEventCorrection,summarizeFreshPosition}from'./accounting.js';
import type{FreshFinancialEvent,FreshAirdropBasis,FreshScope}from'../../shared/freshAccounting.js';
const w='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40),token='0x'+'3'.repeat(40),source='0x'+'4'.repeat(40),hash='0x'+'a'.repeat(64);
const scope:FreshScope={id:'kol:'+w,kind:'kol',accountId:null,walletAddresses:[w],startsBlock:'1',startsAt:'2026-10-21T00:00:00.000Z',revision:'1'};
const incoming=(changed:Partial<FreshFinancialEvent>={}):FreshFinancialEvent=>({id:'claim',executionKey:'claim:0',walletAddress:w,tokenAddress:token,kind:'transfer_in',quantity:'10',amountUsd:null,feeUsd:'0',feeKey:null,counterparty:source,transferKey:null,blockNumber:'100',blockHash:hash,transactionHash:hash,transactionIndex:0,executionIndex:0,logIndex:1,occurredAt:'2026-10-27T00:00:00.000Z',...changed});
const basis=(e:FreshFinancialEvent):FreshAirdropBasis=>({version:1,policy:'verified_airdrop_zero_cost_v1',provenance:'node_authenticated_free_distribution',distributionKind:'authenticated_free_claim',eventId:e.id,walletAddress:e.walletAddress,tokenAddress:e.tokenAddress!,sourceAddress:e.counterparty,quantity:e.quantity,quantityRaw:'10000000000000000000',decimals:18,blockNumber:e.blockNumber,blockHash:e.blockHash,transactionHash:e.transactionHash,transactionIndex:e.transactionIndex,executionIndex:e.executionIndex,logIndex:e.logIndex!,traceSha256:'a'.repeat(64),contextSha256:'b'.repeat(64),authenticationSha256:'c'.repeat(64)});
const proven=(changed:Partial<FreshFinancialEvent>={})=>{const e=incoming(changed);e.airdropBasis=basis(e);return e;};
const sell=(changed:Partial<FreshFinancialEvent>={})=>incoming({id:'sale',executionKey:'sale:0',kind:'sell',counterparty:null,amountUsd:'50',feeUsd:'1',feeKey:'sale-gas',blockNumber:'101',...changed});
describe('verified free acquisition accounting policy',()=>{
 it.each([null,'60'])('uses zero acquisition basis while preserving original fair value %s',amount=>{
  const e=proven({amountUsd:amount}),original=JSON.stringify(e),first=applyFreshEvent(scope,e,{position:null,lots:[]});expect(first.position).toMatchObject({incomingQ:'0',capitalQ:'0',unknownCost:false,unknownIncomingValue:false});expect(first.lots[0]).toMatchObject({costQ:'0',feeKnown:true});expect(JSON.stringify(e)).toBe(original);
  const sold=applyFreshEvent(scope,sell(),first);expect(sold.result.realizedQ).toBe('49');expect(sold.result.capitalQ).toBe('1');expect(summarizeFreshPosition(sold.position!,sold.lots,null)).toMatchObject({realizedProfitUsd:'49',estimatedProfitUsd:'49',status:'complete'});
 });
 it('retains claim gas in FIFO cost and charges sale gas exactly once',()=>{
  const e=proven({amountUsd:'1000',feeUsd:'2',feeKey:'claim-gas'}),first=applyFreshEvent(scope,e,{position:null,lots:[]});expect(first.lots[0].costQ).toBe('2');expect(first.position).toMatchObject({feesQ:'2',capitalQ:'2',incomingQ:'0'});
  const sold=applyFreshEvent(scope,sell({quantity:'5',amountUsd:'80'}),first);expect(sold.result.realizedQ).toBe('78');expect(sold.lots[0].costQ).toBe('1');expect(sold.position?.feesQ).toBe('3');expect(summarizeFreshPosition(sold.position!,sold.lots,'20').estimatedProfitUsd).toBe('177');
 });
 it('does not turn unknown claim fees or ordinary transfer costs into zero',()=>{
  const unpaid=applyFreshEvent(scope,proven({feeUsd:null}),{position:null,lots:[]});expect(unpaid.lots[0].costQ).toBeNull();expect(unpaid.position?.unknownFee).toBe(true);
  const ordinary=applyFreshEvent(scope,incoming(),{position:null,lots:[]});expect(ordinary.lots[0].costQ).toBeNull();expect(ordinary.position?.unknownIncomingValue).toBe(true);expect(applyFreshEvent(scope,sell(),ordinary).result.realizedQ).toBeNull();
  expect(applyFreshEvent(scope,incoming({amountUsd:'60',feeUsd:'1',feeKey:'transfer-gas'}),{position:null,lots:[]}).lots[0].costQ).toBe('61');
 });
 it('cannot replace internal Portfolio FIFO carryover or bypass pairing',()=>{
  const combined={...scope,id:'portfolio:combined',kind:'portfolio_combined' as const,accountId:'private',walletAddresses:[w,other]},buy=incoming({kind:'buy',amountUsd:'100',feeUsd:'1',feeKey:'buy-gas',counterparty:null}),first=applyFreshEvent(combined,buy,{position:null,lots:[]}),out=applyFreshEvent(combined,incoming({id:'out',executionKey:'out:0',kind:'transfer_out',quantity:'4',amountUsd:null,counterparty:other,transferKey:'pair'}),{...first,internalTransferPaired:true}),received=proven({id:'in',executionKey:'in:0',walletAddress:other,quantity:'4',amountUsd:'70',counterparty:w,transferKey:'pair'});received.airdropBasis!.quantityRaw='4000000000000000000';
  expect(()=>applyFreshEvent(combined,received,out)).toThrow('internal_transfer_unreconciled');const paired=applyFreshEvent(combined,received,{...out,internalTransferPaired:true});expect(paired.lots.find(l=>l.walletAddress===other)?.costQ).toBe('202/5');expect(paired.position).toMatchObject({capitalQ:'101',incomingQ:'0',realizedQ:'0'});
 });
 it('deduplicates authenticated claim gas under the existing fee identity',()=>{
  const e=proven({feeUsd:'2',feeKey:'claim-gas'}),first=applyFreshEvent(scope,e,{position:null,lots:[]}),next=proven({id:'claim:second',executionKey:'claim:1',feeUsd:'2',feeKey:'claim-gas'}),second=applyFreshEvent(scope,next,{...first,feeAlreadyApplied:true});expect(second.position?.feesQ).toBe('2');expect(second.position?.capitalQ).toBe('2');expect(second.lots.map(l=>l.costQ)).toEqual(['2','0']);
 });
 it.each(['kind','eventId','walletAddress','sourceAddress','quantityRaw','blockHash','logIndex','traceSha256']as const)('rejects unbound or unsupported %s evidence',key=>{
  const e=proven();if(key==='kind')e.kind='buy';else if(key==='sourceAddress')e.airdropBasis![key]=w;else if(key==='quantityRaw')e.airdropBasis![key]='1';else if(key==='logIndex')e.airdropBasis![key]=2;else(e.airdropBasis as any)[key]='invalid';expect(validFreshAirdropBasis(e)).toBe(false);expect(()=>validateFreshFinancialEvent(e)).toThrow('invalid_airdrop_cost_basis');
 });
 it('requires a real zero-address source for the authenticated-mint subtype',()=>{const e=proven();e.airdropBasis!.distributionKind='authenticated_mint';expect(validFreshAirdropBasis(e)).toBe(false);e.counterparty='0x'+'0'.repeat(40);e.airdropBasis!.sourceAddress=e.counterparty;expect(validFreshAirdropBasis(e)).toBe(true);});
 it('round trips tagged permanent evidence without changing original value',()=>{
  const e=proven({amountUsd:'60'}),p=freshFinancialBasis(e),row={id:e.id,execution_key:e.executionKey,wallet_address:w,token_address:token,kind:e.kind,quantity:e.quantity,amount_usd:e.amountUsd,fee_usd:e.feeUsd,fee_key:e.feeKey,counterparty:e.counterparty,transfer_key:null,block_number:e.blockNumber,block_hash:hash,transaction_hash:hash,transaction_index:0,execution_index:0,log_index:1,occurred_at:e.occurredAt,canonical:true,acquisition_cost:JSON.parse(JSON.stringify(p))},next=freshEventFromRow(row);expect(next.airdropBasis).toEqual(e.airdropBasis);expect(next.acquisitionCost).toBeUndefined();expect(next.amountUsd).toBe('60');expect(validFreshAirdropBasis(next)).toBe(true);expect(freshAirdropBasisKey(next.airdropBasis)).toBe(freshAirdropBasisKey(e.airdropBasis));
 });
 it('permits only additive exact-context proof repairs and retains prior approved basis',()=>{
  const before=incoming({amountUsd:'60'}),after={...before,airdropBasis:basis(before)};expect(freshCostOnlyEventCorrection(before,after)).toBe(true);expect(freshCostOnlyEventCorrection(before,{...after,amountUsd:'0'})).toBe(false);expect(()=>assertFreshEventQuoteCompatible(after,before)).toThrow('conflicting_airdrop_cost_evidence');expect(freshCostOnlyEventCorrection(after,before)).toBe(false);expect(()=>assertFreshEventQuoteCompatible(after,{...after,acquisitionCost:{}as any})).toThrow('conflicting_airdrop_cost_evidence');
 });
});
