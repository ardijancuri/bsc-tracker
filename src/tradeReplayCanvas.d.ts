import type { TradeReplayData } from './tradeReplayData';
export interface ReplaySnapshot {
  time: string | null; invested: number | null; proceeds: number | null; holdings: number | null;
  pnl: number | null; roi: number | null; avgEntryCap: number | null; currentCap: number;
  realizedPnl: number | null; realizedRoi: number | null;
  currentPrice: number; currentEventIndex: number; status: string;
}
export class ReplayCanvas {
  constructor(canvas: HTMLCanvasElement);
  canvas: HTMLCanvasElement;
  data: TradeReplayData | null;
  setData(data: TradeReplayData): Promise<void>;
  getDuration(): number;
  eventProgress(index: number): number;
  snapshot(progress: number): ReplaySnapshot;
  render(progress: number): void;
}
export default ReplayCanvas;
