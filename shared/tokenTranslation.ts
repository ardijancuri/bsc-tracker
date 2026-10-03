export interface TokenTranslation {
  tokenAddress: string | null;
  sourceText: string | null;
  englishName: string | null;
}

const han = /\p{Script=Han}/u;
const otherEastAsian = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export function chineseTokenName(token: { name?: string | null; symbol?: string | null }): string | null {
  for (const value of [token.name, token.symbol]) {
    const source = value?.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (source && han.test(source) && !otherEastAsian.test(source) && new TextEncoder().encode(source).length <= 500 && !/[\u0000-\u001f\u007f]/.test(source)) return source;
  }
  return null;
}
