import{describe,it,expect}from'vitest';import{Interface}from'ethers';
import{freshGangHistoryPrecision,reconcileFreshGangHistory,type FreshGangHistoryImportInput}from'./gangHistoryImport.js';
import{pendingGangFixture,pendingAddress,pendingHash}from'./fixtures/pendingGangTradeFixture.js';
import{GANG_TOKEN_ADDRESS}from'./tracking.js';import{WBNB}from'../launchpad.js';
import{TRUSTED_QUOTE_FEEDS,oracleMarketAbi}from'../nodeMarketProtocols.js';
import type{FreshHistoricalQuoteEvidence}from'./historicalQuote.js';
const word=(raw:bigint)=>'0x'+raw.toString(16).padStart(64,'0');
function fixture():FreshGangHistoryImportInput{
 const f=pendingGangFixture('sell'),entry=structuredClone(f.entry);entry.transaction.gasPrice='0x3b9aca00';entry.receipt.effectiveGasPrice='0x3b9aca00';
 entry.receipt.logs[2].data=word(10n**18n);entry.receipt.logs[1].data='0x'+[10n**18n,0n,0n,10n**18n].map(value=>word(value).slice(2)).join('');
 return{entry,block:f.block,activities:[{walletAddress:f.wallet,pageSha256:'a'.repeat(64),observedAt:'2026-10-25T13:00:00.000Z',row:{wallet:f.wallet,chain:'bsc',tx_hash:entry.transaction.hash,
 timestamp:Math.floor(Date.parse(f.block.timestamp)/1000),event_type:'sell',token:{address:GANG_TOKEN_ADDRESS,total_supply:'99999999999999999999999999'},token_amount:'1',
 quote_address:WBNB,quote_token:{token_address:WBNB,decimals:18},quote_amount:'1.02',cost_usd:'714',price_usd:'714',buy_cost_usd:'9999999999',gas_native:'999',gas_usd:'9999999999'}}]};
}
function quoteProof(input:FreshGangHistoryImportInput,price=900):FreshHistoricalQuoteEvidence{
 const {block}=input,anchor={number:block.number+10,hash:pendingHash(block.number+10),timestamp:'2026-10-25T12:01:00.000Z'},round=(2n<<64n)|1n,updated=BigInt(Math.floor(Date.parse(block.timestamp)/1000)-10);
 const values:[string,unknown[]][]=[['decimals',[8]],['description',['BNB / USD']],['latestRoundData',[round,BigInt(price)*100000000n,updated,updated,round]]];
 return{version:1,kind:'historical_oracle_round',tokenAddress:WBNB,feed:TRUSTED_QUOTE_FEEDS[WBNB].feed,target:{...block},anchor,selectedRound:String(round),nextRound:null,priceUsd:String(price),
 calls:values.map(([method,result])=>({data:oracleMarketAbi.encodeFunctionData(method),result:oracleMarketAbi.encodeFunctionResult(method,result)}))};
}
function addNodeRate(input:FreshGangHistoryImportInput,price:number){const p=quoteProof(input,price);input.entry.stateEvidence={version:1,blockNumber:input.block.number,blockHash:input.block.hash,
 calls:p.calls.map(call=>({to:p.feed,...call}))};}
function transferFixture(){const input=fixture(),wallet=input.entry.wallets[0],sender=pendingAddress(99),tx=input.entry.transaction;
 tx.from=sender;tx.to=GANG_TOKEN_ADDRESS;tx.input='0xa9059cbb'+wallet.slice(2).padStart(64,'0')+word(10n**18n).slice(2);
 const log=input.entry.receipt.logs[0];log.topics[1]='0x'+sender.slice(2).padStart(64,'0');log.topics[2]='0x'+wallet.slice(2).padStart(64,'0');input.entry.receipt.logs=[log];
 input.activities[0].row={...input.activities[0].row,event_type:'transfer_in',from_address:sender,to_address:wallet,price_usd:'2.5',cost_usd:'2.5',quote_amount:'',quote_address:'',quote_token:{}};return input;}
describe('one-time imported GANG quantity reconciliation',()=>{
 it.each([['0.1',10n**17n],['10000000',10n**25n],['732859.3779466473',732859377946647375636495n],['251961.940882296',251961940882295995974075n],
  ['343750.89775998547',343750897759985495386398n],['1358493.2074664684',1358493207466468534982651n]])('matches only eighteen decimals for%s',(reported,raw)=>expect(freshGangHistoryPrecision(raw,reported).decimals).toBe(18));
 it.each(['0','NaN','Infinity','-1','1/2','1e999','0.000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001'])('rejects unsupported provider quantity%s',reported=>expect(()=>freshGangHistoryPrecision(10n**18n,reported)).toThrow());
 it('does not force a quantity mismatch or another implied decimal scale to18',()=>{expect(()=>freshGangHistoryPrecision(10n**17n,'1')).toThrow('precision_ambiguous');expect(()=>freshGangHistoryPrecision(15n*10n**17n,'1')).toThrow('precision_ambiguous');expect(()=>freshGangHistoryPrecision(10n**18n+10000000n,'1')).toThrow('precision_ambiguous');});
});
describe('pure one-time GMGN GANG history reconciliation',()=>{
 it('uses node net settlement and raw gas, not GMGN gross, P&L, gas or current supply',async()=>{const input=fixture(),original=structuredClone(input);const result=await reconcileFreshGangHistory(input),event=result.decoded.events[0];
  expect(event.amountUsd).toBe('700');expect(event.quoteAmount).toBe('1');expect(event.quantity).toBe('1');expect(event.feeUsd).toBe('0.0147');expect(result.decoded.reasons).toEqual([]);
  expect(result.decoded.tokens[0].supplyRaw).toBeNull();expect(result.provenanceByEventId[event.id].derivedFx?.priceUsd).toBe('700');expect(input).toEqual(original);});
 it('gives exact-block retained oracle price priority over imported rate',async()=>{const input=fixture();addNodeRate(input,800);const result=await reconcileFreshGangHistory(input),event=result.decoded.events[0];expect(event.amountUsd).toBe('800');expect(event.feeUsd).toBe('0.0168');
  expect(result.provenanceByEventId[event.id].derivedFx).toBeNull();expect(result.provenanceByEventId[event.id].oracleReferences[0].kind).toBe('retained_block_oracle');});
 it('validates a real-format historical oracle bracket from saved raw calls',async()=>{const input=fixture(),proof=quoteProof(input);input.historicalQuotes=[proof];input.canonicalHeaders=[proof.anchor];
  const result=await reconcileFreshGangHistory(input),event=result.decoded.events[0];expect(event.amountUsd).toBe('900');expect(event.feeUsd).toBe('0.0189');expect(result.provenanceByEventId[event.id].oracleReferences[0].kind).toBe('historical_oracle_round');});
 it('retained exact-block oracle wins even when another valid dated proof is present',async()=>{const input=fixture(),proof=quoteProof(input);input.historicalQuotes=[proof];input.canonicalHeaders=[proof.anchor];addNodeRate(input,800);expect((await reconcileFreshGangHistory(input)).decoded.events[0].amountUsd).toBe('800');});
 it('never overwrites a previously known amount, fee or actual quote',async()=>{const input=fixture(),first=await reconcileFreshGangHistory(input);input.knownEvents=[{...first.decoded.events[0],amountUsd:'699',feeUsd:'0.01',quoteAmount:'0.99'}];
  const result=await reconcileFreshGangHistory(input);expect(result.decoded.events[0].amountUsd).toBe('699');expect(result.decoded.events[0].feeUsd).toBe('0.01');expect(result.decoded.events[0].quoteAmount).toBe('0.99');expect(result.provenanceByEventId[first.decoded.events[0].id].preservedFields).toContain('amountUsd');});
 it('rejects a conflict in original immutable financial quantity',async()=>{const input=fixture(),first=await reconcileFreshGangHistory(input);input.knownEvents=[{...first.decoded.events[0],quantity:'2'}];await expect(reconcileFreshGangHistory(input)).rejects.toThrow('existing_fact_conflict');});
 it('deduplicates byte-equivalent rows while keeping page provenance bounded',async()=>{const input=fixture();input.activities=[...input.activities,{...structuredClone(input.activities[0]),pageSha256:'b'.repeat(64)}];const result=await reconcileFreshGangHistory(input);expect(result.matches).toBe(1);expect(result.decoded.events).toHaveLength(1);});
 it('rejects conflicting same-wallet same-transaction rows',async()=>{const input=fixture();const other=structuredClone(input.activities[0]);other.row.cost_usd='715';input.activities=[...input.activities,other];await expect(reconcileFreshGangHistory(input)).rejects.toThrow('duplicate_activity_ambiguous');});
 it('only imports exact transfer identity and the matched transfer price',async()=>{const input=transferFixture(),result=await reconcileFreshGangHistory(input);expect(result.decoded.events[0].kind).toBe('transfer_in');expect(result.decoded.events[0].amountUsd).toBe('2.5');expect(result.decoded.events[0].feeUsd).toBe('0');expect(result.provenanceByEventId[result.decoded.events[0].id].providerTokenPriceUsd).toBe('2.5');expect(result.provenanceByEventId[result.decoded.events[0].id].nodeFields).not.toContain('settled_quote_raw');});
 it('leaves an unavailable transfer value unknown instead of assuming zero',async()=>{const input=transferFixture();input.activities[0].row.price_usd='';const result=await reconcileFreshGangHistory(input);expect(result.decoded.events[0].amountUsd).toBeNull();expect(result.decoded.reasons).toContain('incoming_transfer_cost_unknown');});
 const reject=(name:string,mutate:(input:FreshGangHistoryImportInput)=>void)=>it(name,async()=>{const input=fixture();mutate(input);await expect(reconcileFreshGangHistory(input)).rejects.toThrow();});
 reject('rejects another token',input=>{(input.activities[0].row.token as any).address=WBNB;});
 reject('rejects another wallet',input=>{input.activities[0].row.wallet=pendingAddress(99);});
 reject('rejects another transaction',input=>{input.activities[0].row.tx_hash=pendingHash(1);});
 reject('rejects another chain',input=>{input.activities[0].row.chain='sol';});
 reject('rejects another block time',input=>{input.activities[0].row.timestamp=Number(input.activities[0].row.timestamp)+1;});
 reject('rejects a different event side',input=>{input.activities[0].row.event_type='buy';});
 reject('rejects transfer labeling of an actual swap',input=>{input.activities[0].row.event_type='transfer_out';});
 reject('rejects missing actual settlement evidence',input=>{input.entry.receipt.logs.pop();});
 reject('rejects signed chain mismatch',input=>{input.entry.transaction.chainId='0x1';});
 reject('rejects an orphan receipt',input=>{input.entry.receipt.blockHash=pendingHash(8);});
 reject('rejects a removed log',input=>{input.entry.receipt.logs[0].removed=true;});
 reject('rejects a supplied trace from another signed transaction',input=>{input.entry.trace={type:'CALL',from:input.entry.transaction.from,to:input.entry.transaction.to!,input:'0xdeadbeef',value:'0x0',output:'0x'};});
 reject('rejects malformed page checksum metadata',input=>{input.activities[0].pageSha256='invalid';});
 reject('rejects a provider observation before the transaction existed',input=>{input.activities[0].observedAt='2026-10-24T00:00:00Z';});
 reject('rejects quote identity mismatch',input=>{input.activities[0].row.quote_address=GANG_TOKEN_ADDRESS;});
 reject('rejects nonpositive historical quote amount',input=>{input.activities[0].row.quote_amount='0';});
 reject('rejects an unsupported current-row oracle proof',input=>{const proof=quoteProof(input);proof.kind='current_oracle' as any;input.historicalQuotes=[proof];input.canonicalHeaders=[proof.anchor];});
 reject('rejects a historical proof for another target',input=>{const proof=quoteProof(input);proof.target.hash=pendingHash(77);input.historicalQuotes=[proof];input.canonicalHeaders=[proof.anchor];});
 reject('rejects an unverified historical feed anchor',input=>{input.historicalQuotes=[quoteProof(input)];});
 reject('rejects an orphan historical feed anchor',input=>{const proof=quoteProof(input);input.historicalQuotes=[proof];input.canonicalHeaders=[{...proof.anchor,hash:pendingHash(77)}];});
 reject('rejects a changed historical answer',input=>{const proof=quoteProof(input);proof.priceUsd='999';input.historicalQuotes=[proof];input.canonicalHeaders=[proof.anchor];});
 it('rejects a foreign exact transfer counterparty',async()=>{const input=transferFixture();input.activities[0].row.from_address=pendingAddress(88);await expect(reconcileFreshGangHistory(input)).rejects.toThrow('transfer_identity_mismatch');});
 it('retains a contradictory node decimal scalar as a real failure',async()=>{const input=fixture(),abi=new Interface(['function decimals() view returns(uint8)']);input.entry.stateEvidence={version:1,blockNumber:input.block.number,blockHash:input.block.hash,calls:[{to:GANG_TOKEN_ADDRESS,data:abi.encodeFunctionData('decimals'),result:abi.encodeFunctionResult('decimals',[17])}]};await expect(reconcileFreshGangHistory(input)).rejects.toThrow('node_precision_conflict');});
});
