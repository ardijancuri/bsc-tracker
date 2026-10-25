import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Film, Image as ImageIcon, Link2, Pause, Play, RefreshCw, Send, Share2 } from 'lucide-react';
import { downloadTradeReplay, recordTradeReplay, type ReplayRecordingCanvas } from './tradeReplayExport';
import { startReplaySession } from './tradeReplaySession';
import { shareableTradeReplay } from './tradeReplaySharing';
import { t } from './i18n';
import './tradeReplay.css';

export interface ReplayShareDefinition {
  kind: 'trade' | 'token';
  title: string; subtitle: string; previewLabel: string; preparingLabel: string; playbackLabel: string; linkLabel: string;
  fileName: string; url: string; caption: string; xIntent: string; controls?: ReactNode;
  prepare(signal: AbortSignal, onWait: (retryAt: number) => void): Promise<ReplayRecordingCanvas>;
  shareFile(file: File): Promise<void>;
  validateAccess?(): Promise<void>;
}

async function loadReplayFonts() {
  if (!document.fonts) return;
  await Promise.all([400, 500, 600, 700, 800].map(weight => document.fonts.load(`${weight} 16px Manrope`)));
}

function replayImage(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The replay image could not be prepared.')), 'image/png');
    } catch (problem) { reject(problem); }
  });
}

export default function ReplayShare({ definition }: { definition: ReplayShareDefinition }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const content = useRef<HTMLElement>(null);
  const player = useRef<ReplayRecordingCanvas | null>(null);
  const progress = useRef(0);
  const frame = useRef(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const sharing = useRef(false);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [seek, setSeek] = useState(0);
  const [exportProgress, setExportProgress] = useState<number | null>(0);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [canRetry, setCanRetry] = useState(true);
  const [sharePending, setSharePending] = useState(false);
  const [imagePending, setImagePending] = useState(false);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const exporting = exportProgress !== null;
  const replayUrl = definition.url;
  const telegramUrl = `https://t.me/share/url?${new URLSearchParams({ url: replayUrl, text: definition.caption })}`;

  const paintPreview = useCallback((renderer: ReplayRecordingCanvas) => {
    const visible = canvas.current;
    if (!visible) return;
    if (visible.width !== renderer.canvas.width) visible.width = renderer.canvas.width;
    if (visible.height !== renderer.canvas.height) visible.height = renderer.canvas.height;
    visible.getContext('2d')?.drawImage(renderer.canvas, 0, 0);
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    alive.current = true;
    setReady(false); setPlaying(false); setFile(null); setSeek(0); setError(''); setCanRetry(true); setNotice(''); setExportProgress(0); setRetryAt(0); setRetrySeconds(0); setImagePending(false); setCopied(false);
    progress.current = 0;
    // Each setup owns its bitmap. A StrictMode cleanup cannot let an earlier
    // encoder repaint or replace the file prepared by the next setup.
    let renderer: ReplayRecordingCanvas | null = null;
    const session = startReplaySession({
      prepare: async signal => {
        await loadReplayFonts();
        if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
        renderer = await definition.prepare(signal, retryAt => {
          if (signal.aborted || generation.current !== currentGeneration) return;
          setRetryAt(retryAt); setRetrySeconds(retryAt ? Math.ceil((retryAt - Date.now()) / 1000) : 0);
        });
      },
      record: async (signal, onProgress) => {
        await definition.validateAccess?.();
        const recorded = await recordTradeReplay(renderer!, definition.fileName, signal, onProgress, definition.kind);
        await definition.validateAccess?.();
        return recorded;
      },
      onReady: () => { player.current = renderer; renderer!.render(0); paintPreview(renderer!); setReady(true); },
      onProgress: value => { progress.current = value; setSeek(value); setExportProgress(value); paintPreview(renderer!); },
      onFile: exported => { renderer!.render(1); paintPreview(renderer!); progress.current = 1; setSeek(1); setFile(exported); },
      onError: problem => {
        if (renderer) { renderer.render(1); paintPreview(renderer); progress.current = 1; setSeek(1); }
        setError(problem instanceof Error ? t(problem.message) : t('Video export failed.'));
        const retryable = !(problem instanceof Error && 'retryable' in problem && problem.retryable === false);
        setCanRetry(retryable); setRetryAt(0); setRetrySeconds(0);
        const retryAfterMs = problem instanceof Error && 'retryAfterMs' in problem ? Number(problem.retryAfterMs) : 0;
        if (retryable && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          setRetryAt(Date.now() + retryAfterMs);
          setRetrySeconds(Math.ceil(retryAfterMs / 1000));
        }
      },
      onFinish: () => setExportProgress(null),
    });
    return () => {
      alive.current = false;
      session.dispose();
      cancelAnimationFrame(frame.current);
      if (player.current === renderer) player.current = null;
    };
  }, [definition, paintPreview, attempt]);

  useEffect(() => {
    if (!retryAt) return;
    const update = () => setRetrySeconds(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);

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
      await definition.validateAccess?.();
      await definition.shareFile(file);
    } catch (problem) {
      if (alive.current && !(problem instanceof DOMException && problem.name === 'AbortError')) setError(t(problem instanceof Error && problem.message.startsWith('Replay ')
        ? problem.message : 'Sharing was unavailable. Download the video and attach it on X.'));
    } finally {
      sharing.current = false;
      if (alive.current) setSharePending(false);
    }
  }

  async function download() {
    if (!file) return;
    try { if (definition.validateAccess) await definition.validateAccess(); downloadTradeReplay(file); setNotice(t('Download started.')); }
    catch (problem) { setError(t(problem instanceof Error ? problem.message : 'Video download failed. Try again.')); setFile(null); }
  }

  function captureImage() {
    const renderer = player.current;
    if (!renderer || !canvas.current) return Promise.reject(new Error('The replay image could not be prepared.'));
    setPlaying(false); cancelAnimationFrame(frame.current);
    progress.current = 1; setSeek(1); renderer.render(1); paintPreview(renderer);
    return replayImage(canvas.current);
  }

  async function saveImage() {
    if (!ready || exporting || imagePending) return;
    const currentGeneration = generation.current;
    setImagePending(true); setError(''); setNotice('');
    try {
      await definition.validateAccess?.();
      const blob = await captureImage();
      if (!alive.current || generation.current !== currentGeneration) return;
      const base = file?.name.replace(/\.(mp4|webm)$/i, '') ?? `${definition.fileName}-${definition.kind}-replay`.replace(/[^a-z0-9-]+/gi, '-').slice(0, 100).toLowerCase();
      downloadTradeReplay(new File([blob], `${base}.png`, { type: 'image/png' }));
      setNotice(t('Image download started.'));
    } catch { if (alive.current && generation.current === currentGeneration) setError(t('The replay image could not be prepared.')); }
    finally { if (alive.current && generation.current === currentGeneration) setImagePending(false); }
  }

  async function copyImage() {
    if (!ready || exporting || imagePending) return;
    setError(''); setNotice('');
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) { setError(t('Image copying is unavailable. Save the image instead.')); return; }
    setImagePending(true);
    try {
      // Create the promised PNG in the click handler to preserve clipboard
      // activation while the canvas finishes producing its image bytes.
      const image = (async () => { await definition.validateAccess?.(); return captureImage(); })();
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
  return <section ref={content} className="trade-replay-content" aria-label={t(definition.title)} tabIndex={-1}>
        <div className="trade-replay-player">
          <div className="trade-replay-preview"><canvas ref={canvas} aria-label={t(definition.previewLabel)} />{!ready && <span>{t(error ? 'Preview unavailable' : definition.preparingLabel)}</span>}</div>
          <div className="trade-replay-playback"><button type="button" disabled={!ready || exporting} aria-label={t(playing ? 'Pause replay' : 'Play replay')} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={13} /> : <Play size={13} />} {t(definition.playbackLabel)}</button><span>1x</span></div>
          <input className="trade-replay-seek" aria-label={t('Replay position')} type="range" min="0" max="1000" value={Math.round(seek * 1000)} disabled={!ready || exporting} onChange={event => { const next = Number(event.target.value) / 1000; setPlaying(false); progress.current = next; setSeek(next); if (player.current) { player.current.render(next); paintPreview(player.current); } }} />
        </div>
        <div className="trade-replay-share-panel">
          <div className="trade-replay-heading"><span className="trade-replay-eyebrow">kollens</span><h2>{t(definition.title)}</h2><p>{definition.subtitle}</p></div>
          {definition.controls}
          <div className="trade-replay-actions">
            <button type="button" disabled={!imageAvailable} onClick={() => void saveImage()}><ImageIcon size={16} /> {t('Save image')}</button>
            <button type="button" disabled={!file || exporting} onClick={download}><Film size={16} /> {t('Save video')}</button>
            <button type="button" className="trade-replay-copy-image" disabled={!imageAvailable} onClick={() => void copyImage()}><Copy size={16} /> {t('Copy image')}</button>
          </div>
          <div className="trade-replay-link"><Link2 size={16} /><input aria-label={t(definition.linkLabel)} value={replayUrl} readOnly onFocus={event => event.currentTarget.select()} /><button type="button" aria-label={t('Copy link')} onClick={() => void copyLink()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <div className="trade-replay-social">
            <button type="button" onClick={() => void copyLink()}><span className="trade-replay-social-icon"><Link2 size={20} /></span><span>{t('Copy link')}</span></button>
            {file && mp4 && !exporting ? <a href={definition.xIntent} target="_blank" rel="noopener noreferrer" onClick={() => setNotice(t('Attach the saved video in your X post.'))}><span className="trade-replay-social-icon trade-replay-x">𝕏</span><span>{t('X (Twitter)')}</span></a> : <button type="button" disabled><span className="trade-replay-social-icon trade-replay-x">𝕏</span><span>{t('X (Twitter)')}</span></button>}
            <a href={telegramUrl} target="_blank" rel="noopener noreferrer"><span className="trade-replay-social-icon"><Send size={19} /></span><span>{t('Telegram')}</span></a>
            {fileShareAvailable && <button type="button" disabled={sharePending || exporting} onClick={() => void share()}><span className="trade-replay-social-icon"><Share2 size={19} /></span><span>{t(sharePending ? 'Sharing…' : definition.title)}</span></button>}
          </div>
          <div className="trade-replay-status" aria-live="polite">
            {exporting ? <><p role="status">{ready ? t('Preparing video {progress}%', { progress: Math.round((exportProgress ?? 0) * 100) }) : retrySeconds > 0 ? t('Retry in {seconds}s', { seconds: retrySeconds }) : t(definition.preparingLabel)}</p><progress aria-label={t('Video preparation progress')} max="1" value={exportProgress ?? 0} /></> : file && <p>{t('Ready to share')} <span>·</span> {mp4 ? 'MP4' : 'WebM'} <span>·</span> {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
            {file && !mp4 && <p>{t('Save the video, or use a browser with MP4 support to share on X.')}</p>}
            {notice && <p role="status">{notice}</p>}
            {error && <p className="trade-replay-error" role="alert">{error}</p>}
            {error && canRetry && !exporting && <button type="button" className="trade-replay-retry" disabled={retrySeconds > 0} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} /> {retrySeconds > 0 ? t('Retry in {seconds}s', { seconds: retrySeconds }) : t('Retry replay')}</button>}
          </div>
        </div>
  </section>;
}
