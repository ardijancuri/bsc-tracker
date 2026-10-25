import { describe, expect, it } from 'vitest';
import { freshPortfolioAddress, freshPortfolioLabel, freshPortfolioScope } from './portfolio.js';
describe('private Portfolio inputs',()=>{
  it('normalizes exact BNB addresses and rejects zero or malformed destinations',()=>{
    expect(freshPortfolioAddress(`0x${'A'.repeat(40)}`)).toBe(`0x${'a'.repeat(40)}`);
    for(const bad of [null,12,'0x1',`0x${'0'.repeat(40)}`,`0x${'g'.repeat(40)}`])expect(()=>freshPortfolioAddress(bad)).toThrow('Invalid BNB wallet address');
  });
  it('keeps labels private strings with a bounded size',()=>{
    expect(freshPortfolioLabel(' My wallet ')).toBe('My wallet');expect(freshPortfolioLabel('')).toBe('');
    for(const bad of [null,'x'.repeat(61),'line\nbreak','bad\0'])expect(()=>freshPortfolioLabel(bad)).toThrow();
  });
  it('scopes every private read and export to one account and selected wallet',()=>{
    expect(freshPortfolioScope('a')).not.toBe(freshPortfolioScope('b'));
    expect(freshPortfolioScope('a','wallet')).not.toBe(freshPortfolioScope('a'));
  });
});
