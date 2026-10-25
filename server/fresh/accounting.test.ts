import { describe, expect, it } from 'vitest';
import { applyFreshEvent, freshDecimal, freshQuantity, freshRationalSum, FreshRational, freshUtcDay, summarizeFreshPosition, validateFreshFinancialEvent } from './accounting.js';
import type { FreshFinancialEvent, FreshLot, FreshPosition, FreshScope } from '../../shared/freshAccounting.js';
const wallet = `0x${'a'.repeat(40)}`, other = `0x${'b'.repeat(40)}`, token = `0x${'c'.repeat(40)}`;
const scope: FreshScope = { id: 'kol:test', kind: 'kol', walletAddresses: [wallet], accountId: null, startsAt: '2026-10-21T00:00:00Z', startsBlock: '10', revision: '1' };
let seq = 0;
function event(overrides: Partial<FreshFinancialEvent> = {}): FreshFinancialEvent {
  const n = ++seq;
  return { id: `event:${n}`, executionKey: `execution:${n}`, walletAddress: wallet, tokenAddress: token, kind: 'buy', quantity: '10', amountUsd: '100', feeUsd: '1', feeKey: `fee:${n}`,
    counterparty: null, transferKey: null, blockNumber: `${10+n}`, blockHash: `0x${n.toString(16).padStart(64,'0')}`, transactionHash: `0x${n.toString(16).padStart(64,'0')}`, transactionIndex: 0, executionIndex: 0, logIndex: 0,
    occurredAt: '2026-10-21T00:01:00Z', ...overrides };
}
function book(selected = scope) {
  let position: FreshPosition | null = null, lots: FreshLot[] = [];
  const fees = new Set<string>();
  return { apply(e: FreshFinancialEvent, paired = false) { const out = applyFreshEvent(selected,e,{position,lots,feeAlreadyApplied: e.feeKey ? fees.has(e.feeKey) : false,internalTransferPaired:paired});
    position=out.position;lots=out.lots;if(e.feeKey)fees.add(e.feeKey);return out; }, get position(){return position!;},get lots(){return lots;} };
}
describe('fresh incremental FIFO', () => {
  it('preserves rational lot costs exactly through repeated partial sales', () => {
    const b=book();b.apply(event({quantity:'3',amountUsd:'1',feeUsd:'0'}));
    const first=b.apply(event({kind:'sell',quantity:'1',amountUsd:'1',feeUsd:'0'}));
    expect(first.result.realizedQ).toBe('2/3');expect(b.lots[0].costQ).toBe('2/3');
    b.apply(event({kind:'sell',quantity:'1',amountUsd:'1',feeUsd:'0'}));b.apply(event({kind:'sell',quantity:'1',amountUsd:'1',feeUsd:'0'}));
    expect(b.position.realizedQ).toBe('2');expect(b.position.quantityQ).toBe('0');expect(b.lots).toHaveLength(0);
  });
  it('preserves a raw unit across the full verified ERC20 decimal range',()=>{
    for(const decimals of [37,77,255]){const tiny=`0.${'0'.repeat(decimals-1)}1`,b=book();b.apply(event({quantity:tiny,amountUsd:'1',feeUsd:'0'}));expect(summarizeFreshPosition(b.position,b.lots,'1').quantity).toBe(tiny);expect(freshQuantity(b.lots[0].quantityQ)).toBe(tiny);expect(freshDecimal(b.lots[0].quantityQ)).toBe('0');}
  });
  it('capitalizes authenticated purchase fees and charges disposal fees once', () => {
    const b=book();b.apply(event());const sell=b.apply(event({kind:'sell',quantity:'5',amountUsd:'80',feeUsd:'2'}));
    expect(sell.result.realizedQ).toBe('55/2');expect(sell.result.capitalQ).toBe('105/2');
    const view=summarizeFreshPosition(b.position,b.lots,'20');
    expect(view.remainingCostUsd).toBe('50.5');expect(view.realizedProfitUsd).toBe('27.5');expect(view.estimatedProfitUsd).toBe('77');
  });
  it('preserves pre-midnight costs when a sale occurs on the next UTC day', () => {
    const b=book();b.apply(event({occurredAt:'2026-10-21T23:59:59Z'}));
    const sold=b.apply(event({kind:'sell',amountUsd:'120',occurredAt:'2026-10-22T00:00:01Z'}));
    expect(sold.result.realizedQ).toBe('18');expect(freshUtcDay(sold.result.occurredAt)).toBe('2026-10-22');
    expect(summarizeFreshPosition(b.position,b.lots,null).estimatedProfitUsd).toBe('18');
  });
  it('transfers FIFO lots internally without creating capital or profit', () => {
    const b=book({...scope,kind:'portfolio_combined',walletAddresses:[wallet,other]});b.apply(event());
    const key='transfer:1';b.apply(event({kind:'transfer_out',quantity:'4',amountUsd:'70',feeUsd:'0',counterparty:other,transferKey:key}),true);
    b.apply(event({walletAddress:other,kind:'transfer_in',quantity:'4',amountUsd:'70',feeUsd:'0',counterparty:wallet,transferKey:key}),true);
    expect(b.position.quantityQ).toBe('10');expect(b.position.capitalQ).toBe('101');expect(b.position.realizedQ).toBe('0');
    expect(b.lots.find(l=>l.walletAddress===other)?.costQ).toBe('202/5');
    const sale=b.apply(event({walletAddress:other,kind:'sell',quantity:'4',amountUsd:'80',feeUsd:'1'}));
    expect(sale.result.realizedQ).toBe('193/5');expect(b.position.incomingQ).toBe('0');expect(b.position.outgoingQ).toBe('0');
  });
  it('keeps wallet-paid fees on internal transfers as losses without adding capital', () => {
    const b=book({...scope,kind:'portfolio_combined',walletAddresses:[wallet,other]});b.apply(event());
    b.apply(event({kind:'transfer_out',quantity:'4',amountUsd:null,feeUsd:'2',counterparty:other,transferKey:'pair'}),true);
    b.apply(event({walletAddress:other,kind:'transfer_in',quantity:'4',amountUsd:null,feeUsd:'0',counterparty:wallet,transferKey:'pair'}),true);
    expect(b.position.realizedQ).toBe('-2');expect(b.position.capitalQ).toBe('101');expect(b.position.feesQ).toBe('3');
  });
  it('values external incoming and outgoing transfers with the agreed receipt policy', () => {
    const b=book();b.apply(event({kind:'transfer_in',amountUsd:'60'}));
    const out=b.apply(event({kind:'transfer_out',amountUsd:'90',feeUsd:'2'}));
    expect(out.result.realizedQ).toBe('27');expect(b.position.incomingQ).toBe('60');expect(b.position.outgoingQ).toBe('90');
  });
  it('never invents zero costs for missing opening lots or unknown fees', () => {
    const b=book();const sold=b.apply(event({kind:'sell',amountUsd:'120'}));
    expect(sold.result.realizedQ).toBeNull();expect(summarizeFreshPosition(b.position,b.lots,null).status).toBe('unknown_costs');
    const c=book();c.apply(event({feeUsd:null}));const next=c.apply(event({kind:'sell',amountUsd:'120'}));expect(next.result.realizedQ).toBeNull();
    const purchase=book();purchase.apply(event({amountUsd:null}));const missing=summarizeFreshPosition(purchase.position,purchase.lots,'2');expect(missing.investedUsd).toBeNull();expect(missing.capitalUsd).toBeNull();expect(missing.soldUsd).toBe('0');
    const incoming=book();incoming.apply(event({kind:'transfer_in',amountUsd:null}));expect(summarizeFreshPosition(incoming.position,incoming.lots,'2').incomingTransferCostUsd).toBeNull();
    const unknownFee=book();unknownFee.apply(event({feeUsd:null}));expect(summarizeFreshPosition(unknownFee.position,unknownFee.lots,'2').feesUsd).toBeNull();
  });
  it('deduplicates one authenticated operation fee across multiple token movements', () => {
    const b=book();b.apply(event({quantity:'1',amountUsd:'1',feeUsd:'1',feeKey:'sameop'}));
    b.apply(event({quantity:'1',amountUsd:'1',feeUsd:'1',feeKey:'sameop',executionIndex:1}));
    expect(b.position.feesQ).toBe('1');expect(b.position.capitalQ).toBe('3');
  });
  it('rejects unmatched internal transfers and events before a private membership boundary', () => {
    const combined={...scope,kind:'portfolio_combined' as const,walletAddresses:[wallet,other],walletStarts:{[wallet]:{startsAt:scope.startsAt,startsBlock:'10'},[other]:{startsAt:'2026-10-22T00:00:00Z',startsBlock:'100'}}};
    expect(()=>applyFreshEvent(combined,event({walletAddress:other}),{position:null,lots:[]})).toThrow('event_outside_scope');
    expect(()=>book(combined).apply(event({kind:'transfer_out',counterparty:other,transferKey:'missing',occurredAt:'2026-10-22T00:01:00Z',blockNumber:'110'}))).toThrow('internal_transfer_unreconciled');
  });
  it('rejects unsafe fee attribution and malformed exact values', () => {
    expect(()=>validateFreshFinancialEvent(event({feeUsd:'2',feeKey:null}))).toThrow('fee_identity_required');
    expect(()=>FreshRational.parse('Infinity')).toThrow();expect(()=>FreshRational.parse('1e9999')).toThrow();
    expect(freshDecimal('-1/3')).toBe('-0.333333333333333333333333333333333333');
  });
  it('validates complete, positive actual trade quotes without using them as USD accounting',()=>{
    const native='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',quoted=event({quoteAddress:native,quoteSymbol:'BNB',quoteAmount:'0.000000000000000001'});
    expect(()=>validateFreshFinancialEvent(quoted)).not.toThrow();const a=book(),b=book();a.apply(quoted);b.apply({...quoted,quoteAddress:undefined,quoteSymbol:undefined,quoteAmount:undefined});expect(a.position).toEqual(b.position);
    for(const changed of[{quoteAmount:'0'},{quoteAmount:'-1'},{quoteAmount:'1/3'},{quoteSymbol:undefined},{quoteAddress:other},{kind:'transfer_in' as const}])
      expect(()=>validateFreshFinancialEvent({...quoted,...changed})).toThrow();
  });
  it('keeps failed-transaction fee events independent of token holdings', () => {
    const b=book();const failed=b.apply(event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeUsd:'0.2',feeAttribution:{status:'eligible',nativeFeeWei:'200000000000000'}}));
    expect(failed.position).toBeNull();expect(failed.result.realizedQ).toBe('-1/5');expect(failed.result.tradeCount).toBe(0);
  });
  it('charges proven failed gas to its token without inventing holdings or trades',()=>{
    const b=book(),failed=event({kind:'fee',quantity:'0',amountUsd:null,feeUsd:'0.2',feeKey:'failed-op',feeAttribution:{status:'eligible',tokenAddress:token,nativeFeeWei:'200000000000000'}});
    const first=b.apply(failed);expect(first.position?.quantityQ).toBe('0');expect(first.position?.feesQ).toBe('1/5');expect(first.result.realizedQ).toBe('-1/5');expect(first.result.tradeCount).toBe(0);expect(first.result.tokensTrade).toBe(false);expect(b.lots).toHaveLength(0);
    b.apply({...failed,id:'duplicate-fee-component',executionIndex:1});expect(b.position.feesQ).toBe('1/5');expect(b.position.realizedQ).toBe('-1/5');
    b.apply(event({amountUsd:'100',feeUsd:'1'}));const open=summarizeFreshPosition(b.position,b.lots,'20');expect(open.realizedProfitUsd).toBe('-0.2');expect(open.estimatedProfitUsd).toBe('98.8');expect(open.quantity).toBe('10');
    expect(()=>validateFreshFinancialEvent({...failed,feeAttribution:{...failed.feeAttribution!,tokenAddress:other}})).toThrow('fee_attribution_token_mismatch');
  });
  it('never applies an unproven fee-only fact to the eligible-token book',()=>{
    const b=book();for(const status of ['unattributed','excluded'] as const)expect(()=>b.apply(event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeAttribution:{status,nativeFeeWei:'12345'}}))).toThrow('fee_outside_accounting_scope');
    expect(()=>b.apply(event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null}))).toThrow('fee_outside_accounting_scope');
    expect(()=>validateFreshFinancialEvent(event({kind:'fee',tokenAddress:null,quantity:'0',amountUsd:null,feeAttribution:{status:'eligible',nativeFeeWei:'-1'}}))).toThrow('invalid_fee_attribution');
  });
  it('retains an exact daily sum after 200 independent coprime-denominator FIFO disposals',()=>{
    // Fixed prime powers approach the uint64 bound while remaining pairwise
    // coprime. Unlike generating random primes, fixture setup is deterministic
    // and does not compete for entropy/CPU with the full parallel suite.
    const primes:number[]=[];for(let candidate=2;primes.length<200;candidate++)if(primes.every(prime=>prime*prime>candidate||candidate%prime!==0))primes.push(candidate);
    const quantities=primes.map(prime=>{let value=BigInt(prime);while(value*BigInt(prime)<=(1n<<64n)-1n)value*=BigInt(prime);return value;});
    let stored='0';
    for(const quantity of quantities){const b=book();b.apply(event({quantity:quantity.toString(),amountUsd:'1',feeUsd:'0'}));const sold=b.apply(event({kind:'sell',quantity:'1',amountUsd:'2',feeUsd:'0'}));stored=freshRationalSum([stored,sold.result.realizedQ!]);}
    expect(stored.length).toBeGreaterThan(2048);
    const exact=FreshRational.parse(stored),denominator=quantities.reduce((product,p)=>product*p,1n),numerator=400n*denominator-quantities.reduce((sum,p)=>sum+denominator/p,0n);
    expect(exact.n*denominator).toBe(numerator*exact.d);expect(FreshRational.parse(exact.exact()).exact()).toBe(stored);
    expect(exact.decimal()).toMatch(/^\d+\.\d{1,36}$/);expect(()=>validateFreshFinancialEvent(event({quantity:'1/2'}))).toThrow('invalid_source_decimal');
  });
  it('cross-cancelled arithmetic preserves exact results for signed reduced fractions',()=>{
    for(let i=1;i<=150;i++){
      const a=new FreshRational(BigInt(i%2?-i:i),BigInt(i+1)),b=new FreshRational(BigInt(i%3?-2*i:2*i),BigInt(i+7));
      const restored=FreshRational.fromStored(a.exact()),sum=restored.add(b),difference=restored.sub(b),product=restored.mul(b),division=restored.div(b);
      expect(sum.n*a.d*b.d).toBe((a.n*b.d+b.n*a.d)*sum.d);expect(difference.n*a.d*b.d).toBe((a.n*b.d-b.n*a.d)*difference.d);
      expect(product.n*a.d*b.d).toBe(a.n*b.n*product.d);expect(division.n*a.d*b.n).toBe(a.n*b.d*division.d);
      expect(FreshRational.parse(sum.exact()).exact()).toBe(sum.exact());expect(FreshRational.parse(product.exact()).exact()).toBe(product.exact());
    }
    expect(()=>new FreshRational(1n).div(new FreshRational(0n))).toThrow('zero_denominator');
    expect(()=>new FreshRational(1n,10n**65_535n).exact()).toThrow('exact_state_budget_exceeded');
  });
});
