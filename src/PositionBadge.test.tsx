import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PositionBadge } from './Intelligence';
import type { Position } from '../shared/intelligence';
const position: Position = { walletAddress: '0x' + '1'.repeat(40), tokenAddress: '0x' + '2'.repeat(40), balance: '0',
  status: 'Exited', checkedAt: '2026-01-01T00:00:00Z', blockNumber: '100', lastMovementAt: '2026-01-01T00:00:00Z', confirmed: true };
describe('canonical position badges', () => {
  it('shows a dated confirmed closed position without a five-minute expiry', () => {
    expect(renderToStaticMarkup(<PositionBadge position={position} />)).toContain('status-exited');
  });
  it('retains confirmed holdings and hides invalidated proof', () => {
    expect(renderToStaticMarkup(<PositionBadge position={{ ...position, status: 'Holding', balance: '10' }} />)).toContain('status-holding');
    expect(renderToStaticMarkup(<PositionBadge position={{ ...position, confirmed: false, checkedAt: new Date().toISOString() }} />)).toContain('status-unknown');
  });
});
