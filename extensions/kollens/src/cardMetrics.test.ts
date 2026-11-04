import {describe, expect, it} from 'vitest';
import {cardMetricColor} from './cardMetrics';

describe('GMGN default metric colors', () => {
  it.each([
    ['$9,999', undefined],
    ['$10K', '#86d99f'],
    ['$29.9k', '#86d99f'],
    ['$30,000', '#4ea7fa'],
    ['$149.9K', '#4ea7fa'],
    ['$150K', '#f2c366'],
    ['$ 0.2M', '#f2c366'],
    ['$0.03B', '#f2c366'],
    ['—', undefined],
  ])('renders %s in the right tier even when the observed color is neutral', (value, color) => {
    expect(cardMetricColor({value,color:'rgb(240, 245, 245)'})).toBe(color);
  });
  it('leaves an unavailable value neutral', () => {
    expect(cardMetricColor(null)).toBeUndefined();
  });
});
