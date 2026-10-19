/** Exact rational market arithmetic. Rounding happens only at the decimal boundary. */
export class MarketDecimal {
  constructor(readonly n: bigint, readonly d = 1n) { if (d <= 0n) throw new Error('invalid_denominator'); }
  static parse(value: string) {
    if (value.length > 256 || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('invalid_decimal');
    const [whole, fraction = ''] = value.split('.');
    return new MarketDecimal(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length));
  }
  static raw(value: bigint, decimals: number) { return new MarketDecimal(value, 10n ** BigInt(decimals)); }
  add(b: MarketDecimal) { return new MarketDecimal(this.n * b.d + b.n * this.d, this.d * b.d); }
  mul(b: MarketDecimal) { return new MarketDecimal(this.n * b.n, this.d * b.d); }
  div(b: MarketDecimal) { if (!b.n) throw new Error('division_by_zero'); return new MarketDecimal(this.n * b.d * (b.n < 0n ? -1n : 1n), this.d * (b.n < 0n ? -b.n : b.n)); }
  compare(b: MarketDecimal) { const v = this.n * b.d - b.n * this.d; return v < 0n ? -1 : v > 0n ? 1 : 0; }
  text() {
    const scale = 10n ** 36n, absolute = this.n < 0n ? -this.n : this.n;
    let raw = absolute * scale / this.d;
    if (absolute * scale % this.d * 2n >= this.d) raw++;
    const fraction = (raw % scale).toString().padStart(36, '0').replace(/0+$/, '');
    return `${this.n < 0n && raw ? '-' : ''}${raw / scale}${fraction ? `.${fraction}` : ''}`;
  }
}
export const positiveDecimal = (value: string) => { try { return MarketDecimal.parse(value).n > 0n; } catch { return false; } };
export const abs = (value: bigint) => value < 0n ? -value : value;
export function ratioPrice(numerator: bigint, denominator: bigint, numeratorDecimals: number, denominatorDecimals: number) {
  if (numerator <= 0n || denominator <= 0n) return null;
  return MarketDecimal.raw(numerator, numeratorDecimals).div(MarketDecimal.raw(denominator, denominatorDecimals)).text();
}
export function sqrtPrice(sqrt: bigint, tokenIs0: boolean, decimals0: number, decimals1: number) {
  if (sqrt <= 0n) return null;
  const price = new MarketDecimal(sqrt * sqrt * 10n ** BigInt(decimals0), (1n << 192n) * 10n ** BigInt(decimals1));
  return (tokenIs0 ? price : new MarketDecimal(1n).div(price)).text();
}
