import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Bookmark,
  CheckCircle2,
  Clipboard,
  Download,
  Eraser,
  FileVideo,
  Film,
  Github,
  Link,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { downloadAsset, type DownloadProgress } from "./lib/download";
import {
  resolveInput,
  type MediaAsset,
  type ResolveProgress,
  type ResolverNote,
} from "./lib/media";

interface DownloadJob {
  assetId: string;
  phase: DownloadProgress["phase"];
  label: string;
  progress: number;
  error?: string;
}

const SAMPLE_URL =
  "https://stream.mux.com/DK00RCfk76exuq2ggfVsnV1ULP9ujkUvLz01Je8dED202g.m3u8";

function App() {
  const [input, setInput] = useState("");
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [notes, setNotes] = useState<ResolverNote[]>([]);
  const [resolveProgress, setResolveProgress] = useState<ResolveProgress | null>(
    null,
  );
  const [isResolving, setIsResolving] = useState(false);
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const aborters = useRef<Record<string, AbortController>>({});
  const resolveRunId = useRef(0);
  const autoAnalyzeTimer = useRef<number | null>(null);

  const activeDownloads = useMemo(
    () =>
      Object.values(jobs).filter(
        (job) => !["complete", "error"].includes(job.phase),
      ).length,
    [jobs],
  );

  async function analyze(value = input) {
    clearAutoAnalyzeTimer();
    const query = value.trim();
    if (!query) {
      setNotes([{ tone: "error", text: "Paste a URL first." }]);
      return;
    }

    const runId = resolveRunId.current + 1;
    resolveRunId.current = runId;
    setIsResolving(true);
    setResolveProgress({ label: "Starting", progress: 0 });
    setNotes([]);

    try {
      const result = await resolveInput(query, (progress) => {
        if (resolveRunId.current === runId) {
          setResolveProgress(progress);
        }
      });
      if (resolveRunId.current !== runId) {
        return;
      }
      setAssets(result.assets);
      setNotes(result.notes);
    } catch (error) {
      if (resolveRunId.current !== runId) {
        return;
      }
      setNotes([{ tone: "error", text: readError(error) }]);
      setAssets([]);
    } finally {
      if (resolveRunId.current === runId) {
        setIsResolving(false);
      }
    }
  }

  async function pasteFromClipboard() {
    try {
      const value = await navigator.clipboard.readText();
      setInput(value);
      queueAutoAnalyze(value);
    } catch (error) {
      setNotes([{ tone: "error", text: readError(error) }]);
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setInput(event.target.value);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const value = event.clipboardData.getData("text/plain");
    if (!shouldAutoAnalyze(value)) {
      return;
    }

    event.preventDefault();
    setInput(value);
    queueAutoAnalyze(value);
  }

  function queueAutoAnalyze(value: string) {
    if (!shouldAutoAnalyze(value)) {
      return;
    }

    clearAutoAnalyzeTimer();
    autoAnalyzeTimer.current = window.setTimeout(() => {
      void analyze(value);
    }, 80);
  }

  function clearAutoAnalyzeTimer() {
    if (autoAnalyzeTimer.current !== null) {
      window.clearTimeout(autoAnalyzeTimer.current);
      autoAnalyzeTimer.current = null;
    }
  }

  async function startDownload(asset: MediaAsset) {
    const controller = new AbortController();
    aborters.current[asset.id] = controller;

    setJobs((current) => ({
      ...current,
      [asset.id]: {
        assetId: asset.id,
        phase: "fetching",
        label: "Queued",
        progress: 0,
      },
    }));

    try {
      await downloadAsset(
        asset,
        (progress) => {
          setJobs((current) => ({
            ...current,
            [asset.id]: {
              assetId: asset.id,
              phase: progress.phase,
              label: progress.label,
              progress: progress.progress,
            },
          }));
        },
        controller.signal,
      );
    } catch (error) {
      setJobs((current) => ({
        ...current,
        [asset.id]: {
          assetId: asset.id,
          phase: "error",
          label: "Failed",
          progress: current[asset.id]?.progress ?? 0,
          error: readError(error),
        },
      }));
    } finally {
      delete aborters.current[asset.id];
    }
  }

  function cancelDownload(assetId: string) {
    aborters.current[assetId]?.abort();
  }

  function clearAll() {
    Object.values(aborters.current).forEach((controller) => controller.abort());
    aborters.current = {};
    clearAutoAnalyzeTimer();
    resolveRunId.current += 1;
    setInput("");
    setAssets([]);
    setNotes([]);
    setJobs({});
    setResolveProgress(null);
    setIsResolving(false);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="fcdl home">
          <span className="brand-mark">f</span>
          <span>
            <strong>fcdl</strong>
            <small>Farcaster video downloader</small>
          </span>
        </a>
        <div className="topbar-actions">
          <span className="status-pill">
            <Sparkles size={15} />
            browser-only
          </span>
          <a
            className="icon-link"
            href="https://github.com/pierce403/fcdl"
            target="_blank"
            rel="noreferrer"
            title="GitHub"
            aria-label="GitHub"
          >
            <Github size={18} />
          </a>
        </div>
      </header>

      <div className="bookmark-reminder" role="note">
        <Bookmark size={17} />
        <span>
          <strong>Bookmark fcdl.net</strong>
          <span>Keep it handy for quick Farcaster video saves.</span>
        </span>
      </div>

      <section className="workspace">
        <div className="input-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">URL</p>
              <h1>Find the video</h1>
            </div>
            <button
              className="icon-button"
              type="button"
              title="Use sample"
              aria-label="Use sample"
              onClick={() => setInput(SAMPLE_URL)}
            >
              <RefreshCw size={18} />
            </button>
          </div>

          <textarea
            value={input}
            onChange={handleInputChange}
            onPaste={handlePaste}
            placeholder="https://farcaster.xyz/user/0x..."
            spellCheck={false}
          />

          <div className="button-row">
            <button className="secondary-button" type="button" onClick={pasteFromClipboard}>
              <Clipboard size={17} />
              Paste
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={isResolving}
              onClick={() => void analyze()}
            >
              {isResolving ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}
              Analyze
            </button>
            <button className="ghost-button" type="button" onClick={clearAll}>
              <Eraser size={17} />
              Clear
            </button>
          </div>

          {resolveProgress && (
            <ProgressPanel
              title={resolveProgress.label}
              progress={resolveProgress.progress}
              compact
            />
          )}
        </div>

        <aside className="queue-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Queue</p>
              <h2>{activeDownloads ? `${activeDownloads} active` : "Idle"}</h2>
            </div>
            <Film size={22} />
          </div>

          {Object.values(jobs).length === 0 ? (
            <EmptyState icon={<Download size={22} />} title="No downloads" />
          ) : (
            <div className="job-list">
              {Object.values(jobs).map((job) => {
                const asset = assets.find((item) => item.id === job.assetId);
                return (
                  <div className="job-row" key={job.assetId}>
                    <div className="job-title">
                      <span>{asset?.filename ?? "video.mp4"}</span>
                      {job.phase === "complete" ? (
                        <CheckCircle2 size={16} />
                      ) : job.phase === "error" ? (
                        <AlertCircle size={16} />
                      ) : (
                        <LoaderCircle className="spin" size={16} />
                      )}
                    </div>
                    <ProgressPanel
                      title={job.error ?? job.label}
                      progress={job.progress}
                      tone={job.phase === "error" ? "error" : "normal"}
                      compact
                    />
                    {!["complete", "error"].includes(job.phase) && (
                      <button
                        className="tiny-button"
                        type="button"
                        onClick={() => cancelDownload(job.assetId)}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </section>

      <section className="results-section">
        <div className="section-title">
          <div>
            <p className="eyebrow">Media</p>
            <h2>{assets.length ? `${assets.length} found` : "None found"}</h2>
          </div>
        </div>

        {notes.length > 0 && (
          <div className="notes">
            {notes.map((note) => (
              <div className={`note note-${note.tone}`} key={`${note.tone}-${note.text}`}>
                {note.tone === "error" ? (
                  <AlertCircle size={17} />
                ) : (
                  <CheckCircle2 size={17} />
                )}
                <span>{note.text}</span>
              </div>
            ))}
          </div>
        )}

        {assets.length === 0 ? (
          <EmptyState icon={<FileVideo size={24} />} title="Waiting for media" />
        ) : (
          <div className="asset-grid">
            {assets.map((asset) => (
              <MediaCard
                asset={asset}
                job={jobs[asset.id]}
                key={asset.id}
                onDownload={() => startDownload(asset)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function MediaCard({
  asset,
  job,
  onDownload,
}: {
  asset: MediaAsset;
  job?: DownloadJob;
  onDownload: () => void;
}) {
  const isBusy = job && !["complete", "error"].includes(job.phase);
  const meta = [
    asset.container.toUpperCase(),
    asset.width && asset.height ? `${asset.width}x${asset.height}` : null,
    asset.cast?.username ? `@${asset.cast.username}` : null,
  ].filter(Boolean);

  return (
    <article className="asset-card">
      <div className="preview">
        {asset.poster ? (
          <img src={asset.poster} alt="" />
        ) : asset.kind === "direct" ? (
          <video src={asset.url} muted playsInline preload="metadata" />
        ) : (
          <FileVideo size={36} />
        )}
        <span className="format-badge">{asset.kind === "hls" ? "HLS to MP4" : asset.container}</span>
      </div>

      <div className="asset-content">
        <div>
          <p className="asset-source">
            <Link size={14} />
            {asset.sourceLabel}
          </p>
          <h3>{asset.filename}</h3>
          {asset.cast?.text && <p className="cast-text">{asset.cast.text}</p>}
        </div>

        <div className="asset-footer">
          <span>{meta.join(" / ")}</span>
          <button className="primary-button small" type="button" disabled={Boolean(isBusy)} onClick={onDownload}>
            {isBusy ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
            Download
          </button>
        </div>
      </div>
    </article>
  );
}

function ProgressPanel({
  title,
  progress,
  tone = "normal",
  compact = false,
}: {
  title: string;
  progress: number;
  tone?: "normal" | "error";
  compact?: boolean;
}) {
  const bounded = Math.max(0, Math.min(progress, 1));

  return (
    <div className={`progress-panel ${compact ? "compact" : ""}`}>
      <div className="progress-label">
        <span>{title}</span>
        <span>{Math.round(bounded * 100)}%</span>
      </div>
      <div className={`progress-track ${tone}`}>
        <span style={{ width: `${bounded * 100}%` }} />
      </div>
    </div>
  );
}

function EmptyState({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="empty-state">
      {icon}
      <span>{title}</span>
    </div>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

function shouldAutoAnalyze(value: string): boolean {
  const url = value.trim().match(/https?:\/\/\S+/i)?.[0] ?? "";
  if (!url) {
    return false;
  }

  return (
    /https?:\/\/(?:www\.)?(?:farcaster\.xyz|warpcast\.com|farcaster\.tv)\//i.test(
      url,
    ) || /\.(?:m3u8|mp4|m4v|mov|webm)(?:[?#\s]|$)/i.test(url)
  );
}

export default App;
