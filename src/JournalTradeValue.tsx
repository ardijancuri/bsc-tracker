import type { JournalTrade } from '../shared/journal';
import { getLocale, t } from './i18n';
import { nativeTradeDisplay } from './nativeTradeDisplay';

export function JournalTradeValue({ trade }: { trade: JournalTrade }) {
  const display = nativeTradeDisplay(trade, getLocale());
  return <span title={t(display.titleKey, { symbol: display.symbol ?? '', amount: display.amount ?? '',
    quoteAmount: trade.quoteAmount ?? '', quoteSymbol: trade.quoteSymbol ?? '' })}>
    {display.kind === 'pending' ? t(display.text) : display.text}
  </span>;
}
