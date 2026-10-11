import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, Film, Pause, Play, Share2, X } from 'lucide-react';
import ReplayCanvas from './tradeReplayCanvas';
import { downloadTradeReplay, recordTradeReplay, supportedReplayFormat } from './tradeReplayExport';
import type { TradeReplayData } from './tradeReplayData';
import { t } from './i18n';
import './tradeReplay.css';

export { prepareTradeReplayData } from './tradeReplayData';

export default function TradeReplayShare({ data, disabled = false }: { data: TradeReplayData | null; disabled?: boolean; compact?: boolean }) {
  const [snapshot, setSnapshot] = useState<TradeReplayData | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setSnapshot(null); requestAnimationFrame(() => trigger.current?.focus()); }, []);
  return <>
    <button ref={trigger} className="trade-replay-trigger" type="button" disabled={disabled || !data?.trades.length} onClick={() => setSnapshot(data)}><Film size={15} /> {t('Share video')}</button>
    {snapshot && <ReplayDialog data={snapshot} onClose={close} />}
  </>;
}

function ReplayDialog({ data, onClose }: { data: TradeReplayData; onClose: () => void }) {
  const titleId = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const player = useRef<ReplayCanvas | null>(null);
  const progress = useRef(0);
  const frame = useRef(0);
  const recording = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [seek, setSeek] = useState(0);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const format = supportedReplayFormat();

  useEffect(() => {
    let disposed = false;
    alive.current = true;
    setReady(false); setPlaying(false); setFile(null); setSeek(0); progress.current = 0;
    if (canvas.current) {
      const renderer = new ReplayCanvas(canvas.current);
      player.current = renderer;
      const fonts = document.fonts?.load('700 32px Manrope') ?? Promise.resolve();
      void Promise.all([fonts, renderer.setData(data)]).then(() => {
        if (!disposed) { renderer.render(0); setReady(true); }
      }).catch(() => { if (!disposed) setError(t('The video preview could not be prepared.')); });
    }
    return () => { disposed = true; alive.current = false; cancelAnimationFrame(frame.current); recording.current?.abort(); player.current = null; };
  }, [data]);

  useEffect(() => {
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose(); }
      if (event.key === 'Tab') {
        const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => document.removeEventListener('keydown', keyboard, true);
  }, [onClose]);

  useEffect(() => {
    if (!playing || !ready || !player.current) return;
    const renderer = player.current;
    if (progress.current >= 1) progress.current = 0;
    const started = performance.now() - progress.current * renderer.getDuration() * 1000;
    const tick = (now: number) => {
      const current = Math.min(1, (now - started) / (renderer.getDuration() * 1000));
      progress.current = current;
      renderer.render(current); setSeek(current);
      if (current < 1) frame.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, ready]);

  async function generate() {
    if (!player.current || recording.current) return;
    setPlaying(false); setError(''); setFile(null);
    const controller = new AbortController();
    recording.current = controller; setExportProgress(0);
    try {
      const exported = await recordTradeReplay(player.current, `${data.kol.name ?? data.kol.address}-${data.token.symbol ?? data.token.address}`, controller.signal, value => { if (alive.current) setExportProgress(value); });
      if (alive.current) { setFile(exported); progress.current = 1; setSeek(1); }
    } catch (problem) {
      if (alive.current && !(problem instanceof DOMException && problem.name === 'AbortError')) setError(problem instanceof Error ? t(problem.message) : t('Video export failed.'));
    } finally {
      recording.current = null;
      if (alive.current) { setExportProgress(null); player.current?.render(progress.current); }
    }
  }

  async function share() {
    if (!file) return;
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: `${data.kol.name ?? 'KOL'} · ${data.token.symbol ?? 'Token'} | bscan` });
      else downloadTradeReplay(file);
    } catch (problem) {
      if (!(problem instanceof DOMException && problem.name === 'AbortError')) setError(t('Sharing was unavailable. Use Download video to save the file.'));
    }
  }

  const exporting = exportProgress !== null;
  return <div className="trade-replay-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="trade-replay-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="trade-replay-top"><div><h2 id={titleId}>{t('Share trade replay')}</h2><p>{data.kol.name ?? 'KOL'} · {data.token.symbol ?? t('Token')} · {t('15.5 seconds')}</p></div><button className="trade-replay-close" type="button" aria-label={t('Close video preview')} onClick={onClose}><X size={20} /></button></div>
      <div className="trade-replay-preview"><canvas ref={canvas} aria-label={t('Animated trade recap preview')} />{!ready && !error && <span>{t('Preparing preview…')}</span>}</div>
      <div className="trade-replay-playback"><button type="button" disabled={!ready || exporting} aria-label={t(playing ? 'Pause replay' : 'Play replay')} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><input aria-label={t('Replay position')} type="range" min="0" max="1000" value={Math.round(seek * 1000)} disabled={!ready || exporting} onChange={event => { const next = Number(event.target.value) / 1000; setPlaying(false); progress.current = next; setSeek(next); player.current?.render(next); }} /><span>{(seek * 15.5).toFixed(1)}s</span></div>
      <p className="trade-replay-note">{t(data.chart.points.length ? 'Historical samples form the line; B/S markers show actual execution prices.' : 'Recorded fills only; market history does not cover these trades.')} {t('Replay pacing prioritizes readable trades. Estimated FDV uses reported supply; P&L excludes gas.')}</p>
      {!data.position.tradeFlowMatched && <p className="trade-replay-note">{t('Open-position values are hidden until trades match a fresh wallet balance. Verified indexed realized profit can still be shown.')}</p>}
      <div className="trade-replay-actions">{exporting ? <><span role="status">{t('Exporting {progress}%', { progress: Math.round(exportProgress * 100) })}</span><button type="button" onClick={() => recording.current?.abort()}>{t('Cancel export')}</button></> : file ? <><button type="button" className="trade-replay-primary" onClick={() => downloadTradeReplay(file)}><Download size={15} /> {t('Download {format}', { format: file.type.includes('mp4') ? 'MP4' : 'WebM' })}</button><button type="button" onClick={() => void share()}><Share2 size={15} /> {t('Share video')}</button></> : <button type="button" className="trade-replay-primary" disabled={!ready || !format} onClick={() => void generate()}><Film size={15} /> {t('Generate {format} video', { format: format?.includes('mp4') ? 'MP4' : 'WebM' })}</button>}</div>
      {!format && <p className="trade-replay-note" role="status">{t('This browser supports the preview but cannot record canvas video.')}</p>}
      {file && <p className="trade-replay-note" role="status">{t('Ready')} · {(file.size / 1024 / 1024).toFixed(1)} MB · 1080 × 1350</p>}
      {error && <p className="trade-replay-error" role="alert">{error}</p>}
    </div>
  </div>;
}
