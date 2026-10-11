import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Film, Image as ImageIcon, Link2, Pause, Play, Send, Share2 } from 'lucide-react';
import ReplayCanvas from './tradeReplayCanvas';
import type { ReplayMarketChart } from '../shared/replayChart';
import { downloadTradeReplay, recordTradeReplay } from './tradeReplayExport';
import { applyReplayMarketChart, type TradeReplayData } from './tradeReplayData';
import { startReplaySession } from './tradeReplaySession';
import { shareableTradeReplay, shareTradeReplayFile, tradeReplayXIntent } from './tradeReplaySharing';
import { t } from './i18n';
import './tradeReplay.css';

export { prepareTradeReplayData } from './tradeReplayData';

async function replayMarketData(data: TradeReplayData, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 22_000);
  try {
    const response = await fetch(`/api/kols/${encodeURIComponent(data.kol.address)}/tokens/${encodeURIComponent(data.token.address)}/replay-chart`, { signal: request.signal });
    if (!response.ok) return data;
    const chart: ReplayMarketChart = await response.json();
    if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
    return applyReplayMarketChart(data, chart);
  } catch {
    if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
    return data;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function replayImage(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The trade image could not be prepared.')), 'image/png');
    } catch (problem) { reject(problem); }
  });
}

export default function TradeReplayShare({ data }: { data: TradeReplayData }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const content = useRef<HTMLElement>(null);
  const player = useRef<ReplayCanvas | null>(null);
  const progress = useRef(0);
  const frame = useRef(0);
  const alive = useRef(true);
  const sharing = useRef(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [seek, setSeek] = useState(0);
  const [exportProgress, setExportProgress] = useState<number | null>(0);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [sharePending, setSharePending] = useState(false);
  const [imagePending, setImagePending] = useState(false);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const exporting = exportProgress !== null;
  const kolName = data.kol.name ?? 'KOL';
  const tokenName = data.token.symbol ?? t('Token');
  const wallet = data.kol.address.trim().toLowerCase();
  const replayUrl = /^0x[0-9a-f]{40}$/.test(wallet) ? `https://kollens.com/kol/${wallet}` : 'https://kollens.com/';
  const telegramUrl = `https://t.me/share/url?${new URLSearchParams({ url: replayUrl, text: `${kolName}'s ${tokenName} trade replay, tracked with kollens.` })}`;

  const paintPreview = useCallback((renderer: ReplayCanvas) => {
    const visible = canvas.current;
    if (!visible) return;
    if (visible.width !== renderer.canvas.width) visible.width = renderer.canvas.width;
    if (visible.height !== renderer.canvas.height) visible.height = renderer.canvas.height;
    visible.getContext('2d')?.drawImage(renderer.canvas, 0, 0);
  }, []);

  useEffect(() => {
    alive.current = true;
    setReady(false); setPlaying(false); setFile(null); setSeek(0); setError(''); setNotice(''); setExportProgress(0);
    progress.current = 0;
    // Each setup owns its bitmap. A StrictMode cleanup cannot let an earlier
    // encoder repaint or replace the file prepared by the next setup.
    const renderer = new ReplayCanvas(document.createElement('canvas'));
    const session = startReplaySession({
      prepare: async signal => {
        const [selected] = await Promise.all([replayMarketData(data, signal), document.fonts?.ready ?? Promise.resolve()]);
        if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
        await renderer.setData(selected);
      },
      record: (signal, onProgress) => recordTradeReplay(renderer, `${kolName}-${tokenName}`, signal, onProgress),
      onReady: () => { player.current = renderer; renderer.render(0); paintPreview(renderer); setReady(true); },
      onProgress: value => { progress.current = value; setSeek(value); setExportProgress(value); paintPreview(renderer); },
      onFile: exported => { renderer.render(1); paintPreview(renderer); progress.current = 1; setSeek(1); setFile(exported); },
      onError: problem => {
        if (renderer.data) { renderer.render(1); paintPreview(renderer); progress.current = 1; setSeek(1); }
        setError(problem instanceof Error ? t(problem.message) : t('Video export failed.'));
      },
      onFinish: () => setExportProgress(null),
    });
    return () => {
      alive.current = false;
      session.dispose();
      cancelAnimationFrame(frame.current);
      if (player.current === renderer) player.current = null;
    };
  }, [data, kolName, tokenName, paintPreview]);

  useEffect(() => {
    content.current?.focus();
  }, []);

  useEffect(() => {
    if (!playing || !ready || exporting || !player.current) return;
    const renderer = player.current;
    if (progress.current >= 1) progress.current = 0;
    const started = performance.now() - progress.current * renderer.getDuration() * 1000;
    const tick = (now: number) => {
      const current = Math.min(1, (now - started) / (renderer.getDuration() * 1000));
      progress.current = current;
      renderer.render(current); paintPreview(renderer); setSeek(current);
      if (current < 1) frame.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, ready, exporting, paintPreview]);

  async function share() {
    if (!file || sharing.current) return;
    sharing.current = true; setSharePending(true); setError(''); setNotice('');
    try {
      await shareTradeReplayFile(file, data);
    } catch (problem) {
      if (alive.current && !(problem instanceof DOMException && problem.name === 'AbortError')) setError(t('Sharing was unavailable. Download the video and attach it on X.'));
    } finally {
      sharing.current = false;
      if (alive.current) setSharePending(false);
    }
  }

  function download() {
    if (!file) return;
    downloadTradeReplay(file);
    setNotice(t('Download started.'));
  }

  function captureImage() {
    const renderer = player.current;
    if (!renderer || !canvas.current) return Promise.reject(new Error('The trade image could not be prepared.'));
    setPlaying(false); cancelAnimationFrame(frame.current);
    progress.current = 1; setSeek(1); renderer.render(1); paintPreview(renderer);
    return replayImage(canvas.current);
  }

  async function saveImage() {
    if (!ready || exporting || imagePending) return;
    setImagePending(true); setError(''); setNotice('');
    try {
      const blob = await captureImage();
      if (!alive.current) return;
      const base = file?.name.replace(/\.(mp4|webm)$/i, '') ?? `${kolName}-${tokenName}-trade-replay`.replace(/[^a-z0-9-]+/gi, '-').slice(0, 100).toLowerCase();
      downloadTradeReplay(new File([blob], `${base}.png`, { type: 'image/png' }));
      setNotice(t('Image download started.'));
    } catch { if (alive.current) setError(t('The trade image could not be prepared.')); }
    finally { if (alive.current) setImagePending(false); }
  }

  async function copyImage() {
    if (!ready || exporting || imagePending) return;
    setError(''); setNotice('');
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) { setError(t('Image copying is unavailable. Save the image instead.')); return; }
    setImagePending(true);
    try {
      // Create the promised PNG in the click handler to preserve clipboard
      // activation while the canvas finishes producing its image bytes.
      const image = captureImage();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
      if (alive.current) setNotice(t('Image copied.'));
    } catch { if (alive.current) setError(t('Image copying is unavailable. Save the image instead.')); }
    finally { if (alive.current) setImagePending(false); }
  }

  async function copyLink() {
    setError(''); setNotice('');
    try {
      await navigator.clipboard.writeText(replayUrl);
      if (alive.current) { setCopied(true); setNotice(t('Link copied.')); }
    } catch { if (alive.current) setError(t('The link could not be copied.')); }
  }

  const mp4 = file?.type.split(';')[0] === 'video/mp4';
  const fileShareAvailable = file ? shareableTradeReplay(file) : false;
  const imageAvailable = ready && !exporting && !imagePending;
  return <section ref={content} className="trade-replay-content" aria-label={t('Share trade')} tabIndex={-1}>
        <div className="trade-replay-player">
          <div className="trade-replay-preview"><canvas ref={canvas} aria-label={t('Animated trade recap preview')} />{!ready && <span>{t(error ? 'Preview unavailable' : 'Preparing trade…')}</span>}</div>
          <div className="trade-replay-playback"><button type="button" disabled={!ready || exporting} aria-label={t(playing ? 'Pause replay' : 'Play replay')} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={13} /> : <Play size={13} />} {t('Replay trade')}</button><span>1x</span></div>
          <input className="trade-replay-seek" aria-label={t('Replay position')} type="range" min="0" max="1000" value={Math.round(seek * 1000)} disabled={!ready || exporting} onChange={event => { const next = Number(event.target.value) / 1000; setPlaying(false); progress.current = next; setSeek(next); if (player.current) { player.current.render(next); paintPreview(player.current); } }} />
        </div>
        <div className="trade-replay-share-panel">
          <div className="trade-replay-heading"><span className="trade-replay-eyebrow">kollens</span><h2>{t('Share trade')}</h2><p>{kolName} <span>·</span> {tokenName}</p></div>
          <div className="trade-replay-actions">
            <button type="button" disabled={!imageAvailable} onClick={() => void saveImage()}><ImageIcon size={16} /> {t('Save image')}</button>
            <button type="button" disabled={!file || exporting} onClick={download}><Film size={16} /> {t('Save video')}</button>
            <button type="button" className="trade-replay-copy-image" disabled={!imageAvailable} onClick={() => void copyImage()}><Copy size={16} /> {t('Copy image')}</button>
          </div>
          <div className="trade-replay-link"><Link2 size={16} /><input aria-label={t('Trade link')} value={replayUrl} readOnly onFocus={event => event.currentTarget.select()} /><button type="button" aria-label={t('Copy link')} onClick={() => void copyLink()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <div className="trade-replay-social">
            <button type="button" onClick={() => void copyLink()}><span className="trade-replay-social-icon"><Link2 size={20} /></span><span>{t('Copy link')}</span></button>
            {file && mp4 && !exporting ? <a href={tradeReplayXIntent(data)} target="_blank" rel="noopener noreferrer" onClick={() => setNotice(t('Attach the saved video in your X post.'))}><span className="trade-replay-social-icon trade-replay-x">𝕏</span><span>{t('X (Twitter)')}</span></a> : <button type="button" disabled><span className="trade-replay-social-icon trade-replay-x">𝕏</span><span>{t('X (Twitter)')}</span></button>}
            <a href={telegramUrl} target="_blank" rel="noopener noreferrer"><span className="trade-replay-social-icon"><Send size={19} /></span><span>{t('Telegram')}</span></a>
            {fileShareAvailable && <button type="button" disabled={sharePending || exporting} onClick={() => void share()}><span className="trade-replay-social-icon"><Share2 size={19} /></span><span>{t(sharePending ? 'Sharing…' : 'Share trade')}</span></button>}
          </div>
          <div className="trade-replay-status" aria-live="polite">
            {exporting ? <><p role="status">{ready ? t('Preparing video {progress}%', { progress: Math.round((exportProgress ?? 0) * 100) }) : t('Preparing trade…')}</p><progress aria-label={t('Video preparation progress')} max="1" value={exportProgress ?? 0} /></> : file && <p>{t('Ready to share')} <span>·</span> {mp4 ? 'MP4' : 'WebM'} <span>·</span> {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
            {file && !mp4 && <p>{t('Save the video, or use a browser with MP4 support to share on X.')}</p>}
            {notice && <p role="status">{notice}</p>}
            {error && <p className="trade-replay-error" role="alert">{error}</p>}
          </div>
        </div>
  </section>;
}
