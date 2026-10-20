import { afterEach, describe, expect, it } from 'vitest';
import { championshipMoney, championshipRoi } from './Championship';
import { setLanguage } from './i18n';

afterEach(() => setLanguage('en'));
describe('championship financial presentation', () => {
  it('converts the provider ratio to a percentage once and uses GMGN compact formatting', () => {
    expect(championshipRoi('6.2119')).toBe('+621.1%');
    expect(championshipRoi('10.8104')).toBe('+1.08K%');
    expect(championshipRoi('-0.125')).toBe('-12.5%');
  });
  it('preserves negative signs and keeps unavailable financial fields distinct from zero', () => {
    expect(championshipMoney('21524.70')).toBe('+$21,524');
    expect(championshipMoney('-123.45')).toBe('-$123');
    expect(championshipMoney('0')).toBe('$0');
    expect(championshipMoney(null)).toBe('—');
    expect(championshipRoi(null)).toBe('—');
    expect(championshipRoi('NaN')).toBe('—');
  });
});
