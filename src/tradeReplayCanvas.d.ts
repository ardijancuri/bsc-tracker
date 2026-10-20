import type { TradeReplayData } from './tradeReplayData';
export interface ReplaySnapshot {
  time: string | null; invested: number | null; proceeds: number | null; holdings: number | null;
  pnl: number | null; roi: number | null; avgEntryCap: number | null; currentCap: number;
  realizedPnl: number | null; realizedRoi: number | null;
  remainingCostBasis: number | null; unrealizedPnl: number | null;
  totalPnl: number | null; totalRoi: number | null;
  currentPrice: number; currentEventIndex: number; status: string; recordedStatus: string;
}
export interface ReplayViewport {
  time: number; startTime: number; endTime: number; spanTime: number;
  startQ: number; endQ: number; yMin: number; yMax: number;
}
export interface ReplayMarkerPosition {
  index: number; ts: number; q: number; x: number; y: number; anchorY: number;
  marketValue: number; executionValue: number | null; visible: boolean; alpha: number;
}
export class ReplayCanvas {
  constructor(canvas: HTMLCanvasElement);
  canvas: HTMLCanvasElement;
  data: TradeReplayData | null;
  setData(data: TradeReplayData): Promise<void>;
  getDuration(): number;
  eventProgress(index: number): number;
  chartProgress(progress: number): number;
  timeAt(progress: number): number;
  valueAtTime(time: number): { priceUsd: number; marketCapUsd: number };
  valueAtStory(progress: number): { priceUsd: number; marketCapUsd: number };
  viewportAt(progress: number): ReplayViewport;
  markerPosition(index: number, progress: number): ReplayMarkerPosition | null;
  visibleLine(progress: number, viewport?: ReplayViewport): { ts: number; q: number; cap: number; x: number; y: number }[];
  snapshot(progress: number): ReplaySnapshot;
  render(progress: number): void;
}
export default ReplayCanvas;
