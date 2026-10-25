import type {PoolClient} from 'pg';
import type {FreshFinancialEvent} from '../../shared/freshAccounting.js';
import {FreshRational,freshEventFromRow,freshSameTradeQuoteContext} from './accounting.js';
import {WBNB} from '../launchpad.js';

/** A display conversion, never a replacement settlement or accounting input.
 * The decoder supplies a block-pinned node BNB/USD observation. Ordinary
 * pages divide two compact stored decimals and make no provider/RPC calls. */
export function freshTradeBnbEquivalent(row:{amount_usd?:unknown;bnb_price_usd?:unknown;quote_address?:unknown}){
  try{
    if(row.quote_address===WBNB||typeof row.amount_usd!=='string'||typeof row.bnb_price_usd!=='string'
      ||row.bnb_price_usd.length>384||!/^\d+(?:\.\d+)?$/.test(row.bnb_price_usd))return null;
    const value=FreshRational.parse(row.amount_usd),price=FreshRational.parse(row.bnb_price_usd);
    if(value.n<0n||price.n<=0n)return null;
    return value.div(price).decimal();
  }catch{return null;}
}

/** Add a dated rate once under the exact original canonical financial context.
 * No quote, USD value, fee, FIFO row, scope revision or P&L total is changed. */
export async function persistFreshTradeBnbPrice(client:Pick<PoolClient,'query'>,event:FreshFinancialEvent,priceUsd:string){
  if(!['buy','sell'].includes(event.kind)||event.canonical===false||event.quoteAddress==null||event.quoteAddress===WBNB||event.amountUsd===null
    ||typeof priceUsd!=='string'||priceUsd.length>384||!/^\d+(?:\.\d+)?$/.test(priceUsd)||FreshRational.parse(priceUsd).n<=0n)throw Error('invalid_trade_bnb_display_rate');
  const row=(await client.query('SELECT * FROM fresh.financial_events WHERE id=$1 FOR UPDATE',[event.id])).rows[0];
  if(!row||!freshSameTradeQuoteContext(freshEventFromRow(row),event)||row.amount_usd!==event.amountUsd||row.quote_address!==event.quoteAddress
    ||row.quote_amount!==event.quoteAmount||row.quote_symbol!==event.quoteSymbol)throw Error('trade_bnb_display_context_changed');
  if(row.bnb_price_usd!=null){
    if(FreshRational.parse(row.bnb_price_usd).compare(FreshRational.parse(priceUsd))!==0)throw Error('conflicting_trade_bnb_display_rate');
    return false;
  }
  return(await client.query('UPDATE fresh.financial_events SET bnb_price_usd=$2 WHERE id=$1 AND canonical AND bnb_price_usd IS NULL',[event.id,priceUsd])).rowCount===1;
}
