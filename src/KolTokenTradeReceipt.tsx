import type { KolTokenTrade } from '../shared/kolTokenTrades';
import { getLocale, localDate, t } from './i18n';
import { compact, shortAddress } from './lib';
import { nativeTradeDisplay } from './nativeTradeDisplay';

/** Settlement stays visible in the transaction details even when the feed
 * presents its historical BNB equivalent. It never changes replay accounting. */
export function KolTokenTradeReceipt({ trade }: { trade: KolTokenTrade }) {
  const amount = trade.valuationStatus === 'valued' ? trade.amountUsd : null;
  const valuationNote = trade.valuationStatus === 'shared_quote' ? t('Transaction spend could not be allocated to this token')
    : amount == null ? t('Trade valuation unavailable') : undefined;
  const display = nativeTradeDisplay(trade, getLocale());
  const symbol = display.kind === 'quote' ? display.symbol : trade.quoteSymbol?.trim();
  const settlement = display.kind === 'quote' || display.kind === 'bnb_equivalent' ? `${trade.quoteAmount} ${symbol}` : null;
  const equivalent = display.kind === 'bnb_equivalent' && trade.valuationStatus === 'valued' ? display : null;
  const formattedUsd = amount == null || !Number.isFinite(Number(amount)) ? '—'
    : new Intl.NumberFormat(getLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(amount));
  const acquisitionNote=trade.acquisitionCost?t('Purchase cost is allocated from the recorded payment. Quote change keeps its original cost: {amount} USD.',{amount:trade.acquisitionCost.remainingQuoteCostUsd}):undefined;
  const equivalentTitle = equivalent ? t(equivalent.titleKey, { amount: equivalent.amount ?? '',
    quoteAmount: trade.quoteAmount ?? '', quoteSymbol: symbol! }) : valuationNote;
  return <div className="kol-trade-receipt">
    <span className={`kol-trade-side ${trade.side}`}>{t(trade.side)}</span>
    <span className="kol-trade-receipt-values">
      <span className="kol-trade-receipt-main"><strong title={[equivalentTitle,acquisitionNote].filter(Boolean).join(' ')||undefined}>{equivalent?.text ?? formattedUsd}</strong>
        <span>{t('at {value} MCAP', { value: compact(trade.marketCapUsd, true) })}</span></span>
      {settlement && <small className="kol-trade-settlement" title={t('Recorded {symbol} trade amount: {amount}', {
        symbol: symbol!, amount: trade.quoteAmount! })}>{settlement}</small>}
    </span>
    <span className="kol-trade-receipt-time"><time dateTime={trade.timestamp} title={localDate(trade.timestamp)}>{new Date(trade.timestamp).toLocaleString(getLocale(), {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    })}</time><span>{shortAddress(trade.txHash)}</span></span>
  </div>;
}
