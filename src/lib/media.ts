export type MediaKind = "direct" | "hls";

export type NoteTone = "info" | "warning" | "error";

export interface ResolverNote {
  tone: NoteTone;
  text: string;
}

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  url: string;
  title: string;
  filename: string;
  container: "mp4" | "webm" | "mov" | "m4v" | "hls" | "unknown";
  mimeType: string;
  width?: number;
  height?: number;
  poster?: string;
  sourceLabel: string;
  cast?: {
    author: string;
    username: string;
    text: string;
    hash: string;
    url: string;
  };
}

export interface ResolveProgress {
  label: string;
  progress: number;
}

export interface ResolveResult {
  assets: MediaAsset[];
  notes: ResolverNote[];
}

interface FarcasterPointer {
  username?: string;
  hash: string;
  url: string;
}

interface FarcasterTvCast {
  hash: string;
  text?: string;
  author?: {
    displayName?: string;
    username?: string;
  };
  embeds?: {
    videos?: Array<{
      url?: string;
      sourceUrl?: string;
      thumbnailUrl?: string;
      width?: number;
      height?: number;
    }>;
    urls?: unknown[];
    unknowns?: unknown[];
  };
}

interface FarcasterTvResponse {
  result?: {
    casts?: FarcasterTvCast[];
  };
}

const MEDIA_EXTENSIONS = [
  "mp4",
  "m4v",
  "mov",
  "webm",
  "m3u8",
] as const;

const URL_PATTERN =
  /https?:\/\/(?:[^\s<>"'`{}|\\^()[\]]|\\\/)+/gi;

export async function resolveInput(
  input: string,
  onProgress?: (progress: ResolveProgress) => void,
): Promise<ResolveResult> {
  const notes: ResolverNote[] = [];
  const assets = new Map<string, MediaAsset>();
  const normalized = normalizePastedText(input);

  onProgress?.({ label: "Scanning input", progress: 0.08 });
  addAssets(assets, extractMediaUrls(normalized), "Pasted URL");

  const farcasterPointers = extractFarcasterPointers(normalized);
  const resolvablePointers = farcasterPointers.filter((pointer) => pointer.username);
  const unsupportedPointers = farcasterPointers.filter((pointer) => !pointer.username);

  if (unsupportedPointers.length > 0) {
    notes.push({
      tone: "warning",
      text: "Conversation-only Farcaster URLs need the author segment. Paste the cast URL with username/hash when possible.",
    });
  }

  for (const [index, pointer] of resolvablePointers.entries()) {
    onProgress?.({
      label: `Resolving @${pointer.username}`,
      progress: 0.18 + (index / Math.max(resolvablePointers.length, 1)) * 0.42,
    });

    try {
      const resolved = await resolveFarcasterPointer(pointer);
      addAssets(assets, resolved.assets);
      notes.push(...resolved.notes);
    } catch (error) {
      notes.push({
        tone: "warning",
        text: `Could not resolve ${pointer.url}: ${readError(error)}`,
      });
    }
  }

  const urls = extractUrls(normalized).filter((url) => !isKnownMediaUrl(url));
  for (const [index, url] of urls.entries()) {
    if (!shouldTryPageScrape(url, farcasterPointers)) {
      continue;
    }

    onProgress?.({
      label: "Checking page metadata",
      progress: 0.62 + (index / Math.max(urls.length, 1)) * 0.26,
    });

    try {
      const response = await fetch(url, {
        headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      });
      if (!response.ok) {
        continue;
      }
      const text = await response.text();
      addAssets(assets, extractMediaUrls(normalizePastedText(text)), "Page metadata");
    } catch {
      notes.push({
        tone: "info",
        text: "Some pages block browser metadata reads; direct media URLs and Farcaster cast URLs still work.",
      });
      break;
    }
  }

  onProgress?.({ label: "Ready", progress: 1 });

  if (assets.size === 0 && notes.every((note) => note.tone !== "error")) {
    notes.push({
      tone: "error",
      text: "No downloadable video was found in that input.",
    });
  }

  return { assets: Array.from(assets.values()), notes: dedupeNotes(notes) };
}

function addAssets(
  assets: Map<string, MediaAsset>,
  urlsOrAssets: Array<string | MediaAsset>,
  sourceLabel?: string,
): void {
  for (const item of urlsOrAssets) {
    const asset =
      typeof item === "string" ? createMediaAsset(item, { sourceLabel }) : item;
    if (!asset) {
      continue;
    }
    assets.set(normalizeUrlKey(asset.url), asset);
  }
}

async function resolveFarcasterPointer(
  pointer: FarcasterPointer,
): Promise<ResolveResult> {
  const endpoint = `https://farcaster.tv/${encodeURIComponent(
    pointer.username ?? "",
  )}/${encodeURIComponent(pointer.hash)}`;
  const response = await fetch(endpoint, { headers: { accept: "application/json" } });

  if (!response.ok) {
    throw new Error(`resolver returned ${response.status}`);
  }

  const payload = (await response.json()) as FarcasterTvResponse;
  const casts = payload.result?.casts ?? [];
  const cast =
    [...casts].reverse().find((item) => item.hash?.includes(pointer.hash)) ??
    casts[0];

  if (!cast) {
    return {
      assets: [],
      notes: [{ tone: "error", text: "That cast could not be found." }],
    };
  }

  const castUrl = `https://farcaster.xyz/${cast.author?.username ?? pointer.username}/${cast.hash}`;
  const castMeta = {
    author: cast.author?.displayName ?? cast.author?.username ?? "Farcaster",
    username: cast.author?.username ?? pointer.username ?? "",
    text: cast.text ?? "",
    hash: cast.hash,
    url: castUrl,
  };

  const videoAssets = (cast.embeds?.videos ?? [])
    .map((video, index) =>
      createMediaAsset(video.sourceUrl ?? video.url ?? "", {
        title: titleFromCast(cast, index),
        sourceLabel: "Farcaster embed",
        width: video.width,
        height: video.height,
        poster: video.thumbnailUrl,
        cast: castMeta,
      }),
    )
    .filter((asset): asset is MediaAsset => Boolean(asset));

  const deepUrls = extractMediaUrls(JSON.stringify(cast));
  const deepAssets = deepUrls
    .map((url, index) =>
      createMediaAsset(url, {
        title: titleFromCast(cast, videoAssets.length + index),
        sourceLabel: "Farcaster metadata",
        cast: castMeta,
      }),
    )
    .filter((asset): asset is MediaAsset => Boolean(asset));

  const assets = [...videoAssets, ...deepAssets];

  return {
    assets: dedupeAssets(assets),
    notes:
      assets.length > 0
        ? []
        : [{ tone: "error", text: "That cast does not contain a video embed." }],
  };
}

function createMediaAsset(
  rawUrl: string,
  options: Partial<MediaAsset> = {},
): MediaAsset | null {
  if (!rawUrl) {
    return null;
  }

  const url = cleanUrl(rawUrl);
  const classification = classifyMediaUrl(url);

  if (!classification) {
    return null;
  }

  const title = options.title ?? titleFromUrl(url);
  const extension = classification.container === "hls" ? "mp4" : classification.container;

  return {
    id: stableId(url),
    kind: classification.kind,
    url,
    title,
    filename: `${slugify(title) || "farcaster-video"}.${extension}`,
    container: classification.container,
    mimeType: classification.mimeType,
    width: options.width,
    height: options.height,
    poster: options.poster,
    sourceLabel: options.sourceLabel ?? "Media URL",
    cast: options.cast,
  };
}

function classifyMediaUrl(url: string):
  | Pick<MediaAsset, "kind" | "container" | "mimeType">
  | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const path = parsed.pathname.toLowerCase();

  if (path.endsWith(".m3u8") || url.toLowerCase().includes(".m3u8")) {
    return {
      kind: "hls",
      container: "hls",
      mimeType: "application/vnd.apple.mpegurl",
    };
  }

  if (path.endsWith(".mp4") || url.toLowerCase().includes(".mp4?")) {
    return { kind: "direct", container: "mp4", mimeType: "video/mp4" };
  }

  if (path.endsWith(".m4v")) {
    return { kind: "direct", container: "m4v", mimeType: "video/x-m4v" };
  }

  if (path.endsWith(".mov")) {
    return { kind: "direct", container: "mov", mimeType: "video/quicktime" };
  }

  if (path.endsWith(".webm")) {
    return { kind: "direct", container: "webm", mimeType: "video/webm" };
  }

  return null;
}

function extractMediaUrls(input: string): string[] {
  return extractUrls(input).filter(isKnownMediaUrl);
}

function extractUrls(input: string): string[] {
  const matches = input.match(URL_PATTERN) ?? [];
  return unique(
    matches
      .map(cleanUrl)
      .filter((url) => {
        try {
          new URL(url);
          return true;
        } catch {
          return false;
        }
      }),
  );
}

function extractFarcasterPointers(input: string): FarcasterPointer[] {
  return uniqueBy(
    extractUrls(input)
      .map((url) => {
        try {
          return new URL(url);
        } catch {
          return null;
        }
      })
      .filter((url): url is URL => Boolean(url))
      .map(parseFarcasterUrl)
      .filter((pointer): pointer is FarcasterPointer => Boolean(pointer)),
    (pointer) => `${pointer.username ?? ""}:${pointer.hash}`,
  );
}

function parseFarcasterUrl(url: URL): FarcasterPointer | null {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const looksFarcaster =
    host.includes("farcaster") ||
    host.includes("warpcast") ||
    host.includes("supercast") ||
    host.includes("herocast") ||
    host.includes("recaster");

  if (!looksFarcaster) {
    return null;
  }

  const parts = url.pathname
    .split("/")
    .map((part) => decodeURIComponent(part.trim()))
    .filter(Boolean);
  const hashIndex = parts.findIndex((part) => /^0x[a-f0-9]{6,64}$/i.test(part));

  if (hashIndex === -1) {
    return null;
  }

  const hash = parts[hashIndex];
  const previous = parts[hashIndex - 1];
  const username =
    previous && previous !== "~" && previous !== "conversations"
      ? previous.replace(/^@/, "")
      : undefined;

  return { username, hash, url: url.toString() };
}

function shouldTryPageScrape(url: string, pointers: FarcasterPointer[]): boolean {
  if (pointers.some((pointer) => pointer.url === url && pointer.username)) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function titleFromCast(cast: FarcasterTvCast, index: number): string {
  const user = cast.author?.username ? `@${cast.author.username}` : "farcaster";
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `${user}-${cast.hash.slice(0, 10)}${suffix}`;
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").filter(Boolean).pop();
    if (filename) {
      return filename.replace(/\.[a-z0-9]+$/i, "");
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "farcaster-video";
  }
}

function isKnownMediaUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  return MEDIA_EXTENSIONS.some(
    (extension) =>
      lowered.includes(`.${extension}?`) ||
      lowered.includes(`.${extension}#`) ||
      lowered.endsWith(`.${extension}`),
  );
}

function normalizePastedText(input: string): string {
  return input
    .replaceAll("\\/", "/")
    .replaceAll("&amp;", "&")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\u003d", "=")
    .replaceAll("\\u003f", "?");
}

function cleanUrl(url: string): string {
  return url
    .replaceAll("\\/", "/")
    .replace(/[),.;\]}"']+$/g, "")
    .trim();
}

function normalizeUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/@/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stableId(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const itemKey = key(value);
    if (seen.has(itemKey)) {
      return false;
    }
    seen.add(itemKey);
    return true;
  });
}

function dedupeAssets(assets: MediaAsset[]): MediaAsset[] {
  return uniqueBy(assets, (asset) => normalizeUrlKey(asset.url));
}

function dedupeNotes(notes: ResolverNote[]): ResolverNote[] {
  return uniqueBy(notes, (note) => `${note.tone}:${note.text}`);
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
