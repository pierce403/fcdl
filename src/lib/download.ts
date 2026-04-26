import { FFmpeg } from "@ffmpeg/ffmpeg";
import { prepareFmp4HlsDownload, type Fmp4Download } from "./fmp4";
import { prepareHlsInput } from "./hls";
import type { MediaAsset } from "./media";

export type DownloadPhase =
  | "idle"
  | "fetching"
  | "preparing"
  | "muxing"
  | "saving"
  | "complete"
  | "error";

export interface DownloadProgress {
  phase: DownloadPhase;
  label: string;
  progress: number;
}

let ffmpegPromise: Promise<FFmpeg> | null = null;

export async function downloadAsset(
  asset: MediaAsset,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (asset.kind === "hls") {
    await downloadHlsAsset(asset, onProgress, signal);
    return;
  }

  await downloadDirectAsset(asset, onProgress, signal);
}

async function downloadDirectAsset(
  asset: MediaAsset,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  onProgress?.({ phase: "fetching", label: "Fetching video", progress: 0.02 });
  const blob = await fetchBlob(asset.url, asset.mimeType, (progress) => {
    onProgress?.({
      phase: "fetching",
      label: "Fetching video",
      progress: progress * 0.9,
    });
  }, signal);

  onProgress?.({ phase: "saving", label: "Saving file", progress: 0.96 });
  saveBlob(blob, asset.filename);
  onProgress?.({ phase: "complete", label: "Complete", progress: 1 });
}

async function downloadHlsAsset(
  asset: MediaAsset,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const jobId = `${asset.id}-${Date.now().toString(36)}`;

  onProgress?.({ phase: "preparing", label: "Checking HLS stream", progress: 0.02 });
  let fmp4Download: Fmp4Download | null = null;
  try {
    fmp4Download = await prepareFmp4HlsDownload(
      asset.url,
      (progress) => {
        onProgress?.({
          phase: "preparing",
          label: progress.label,
          progress: Math.min(0.94, progress.progress),
        });
      },
      signal,
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    onProgress?.({ phase: "muxing", label: "Using FFmpeg fallback", progress: 0.02 });
  }

  if (fmp4Download) {
    onProgress?.({
      phase: "saving",
      label: `Saving ${fmp4Download.label}`,
      progress: 0.96,
    });
    saveBlob(fmp4Download.blob, asset.filename);
    onProgress?.({ phase: "complete", label: "Complete", progress: 1 });
    return;
  }

  onProgress?.({ phase: "muxing", label: "Loading FFmpeg core", progress: 0.02 });
  const ffmpeg = await getFfmpeg((progress) => {
    onProgress?.({
      phase: "muxing",
      label: progress.label,
      progress: 0.02 + progress.progress * 0.16,
    });
  });

  signal?.throwIfAborted();
  onProgress?.({ phase: "preparing", label: "Preparing HLS", progress: 0.02 });
  const prepared = await prepareHlsInput(
    asset.url,
    jobId,
    (progress) => {
      onProgress?.({
        phase: "preparing",
        label: progress.label,
        progress: 0.2 + Math.min(progress.progress * 0.5, 0.5),
      });
    },
    signal,
  );

  onProgress?.({
    phase: "muxing",
    label: `Loading muxer for ${prepared.label}`,
    progress: 0.72,
  });

  signal?.throwIfAborted();
  for (const file of prepared.files) {
    await ffmpeg.writeFile(file.name, file.data);
  }

  const outputName = `${jobId}-output.mp4`;
  const args = buildMuxArgs(prepared.videoPlaylist, prepared.audioPlaylist, outputName);

  ffmpeg.on("progress", ({ progress }) => {
    onProgress?.({
      phase: "muxing",
      label: "Muxing MP4",
      progress: 0.84 + Math.max(0, Math.min(progress, 1)) * 0.1,
    });
  });

  const exitCode = await ffmpeg.exec(args);
  if (exitCode !== 0) {
    throw new Error(`FFmpeg exited with code ${exitCode}`);
  }

  const fileData = await ffmpeg.readFile(outputName);
  const bytes =
    typeof fileData === "string" ? new TextEncoder().encode(fileData) : fileData;

  onProgress?.({ phase: "saving", label: "Saving MP4", progress: 0.96 });
  saveBlob(new Blob([toArrayBuffer(bytes)], { type: "video/mp4" }), asset.filename);
  onProgress?.({ phase: "complete", label: "Complete", progress: 1 });

  await cleanupFiles(ffmpeg, [...prepared.files.map((file) => file.name), outputName]);
}

function buildMuxArgs(
  videoPlaylist: string,
  audioPlaylist: string | undefined,
  outputName: string,
): string[] {
  const inputFlags = ["-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL"];
  const args = ["-hide_banner", "-y", ...inputFlags, "-i", videoPlaylist];

  if (audioPlaylist) {
    args.push(...inputFlags, "-i", audioPlaylist);
    args.push("-map", "0:v:0", "-map", "1:a:0?", "-c", "copy");
  } else {
    args.push("-c", "copy");
  }

  args.push("-movflags", "+faststart", outputName);
  return args;
}

async function getFfmpeg(
  onProgress?: (progress: { label: string; progress: number }) => void,
): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const coreBaseUrl = new URL("/vendor/ffmpeg/", window.location.href);

      onProgress?.({ label: "Loading FFmpeg core", progress: 0.15 });
      await ffmpeg.load({
        coreURL: new URL("ffmpeg-core.js", coreBaseUrl).toString(),
        wasmURL: new URL("ffmpeg-core.wasm", coreBaseUrl).toString(),
      });
      onProgress?.({ label: "FFmpeg ready", progress: 1 });

      return ffmpeg;
    })();
  }

  return ffmpegPromise;
}

async function fetchBlob(
  url: string,
  mimeType: string,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Could not fetch video: ${response.status}`);
  }

  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  const reader = response.body?.getReader();

  if (!reader) {
    const blob = await response.blob();
    onProgress?.(1);
    return blob;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(contentLength ? received / contentLength : 0.45);
    }
  }

  onProgress?.(1);
  return new Blob(chunks.map(toArrayBuffer), { type: mimeType });
}

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

async function cleanupFiles(ffmpeg: FFmpeg, files: string[]): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      try {
        await ffmpeg.deleteFile(file);
      } catch {
        // Some FFmpeg runs leave optional files absent; cleanup is best effort.
      }
    }),
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
