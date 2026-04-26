export interface HlsProgress {
  label: string;
  progress: number;
}

export interface PreparedFile {
  name: string;
  data: Uint8Array;
}

export interface PreparedHlsInput {
  files: PreparedFile[];
  videoPlaylist: string;
  audioPlaylist?: string;
  label: string;
}

interface HlsVariant {
  uri: string;
  bandwidth: number;
  width?: number;
  height?: number;
  audioGroupId?: string;
}

interface HlsRendition {
  type: string;
  groupId?: string;
  name?: string;
  uri?: string;
  isDefault: boolean;
}

interface PreparedPlaylist {
  playlistName: string;
  files: PreparedFile[];
  resourceCount: number;
}

interface PlaylistResource {
  url: string;
  name: string;
}

interface FetchedText {
  text: string;
  url: string;
}

export async function prepareHlsInput(
  manifestUrl: string,
  id: string,
  onProgress?: (progress: HlsProgress) => void,
  signal?: AbortSignal,
): Promise<PreparedHlsInput> {
  onProgress?.({ label: "Reading HLS manifest", progress: 0.04 });
  const manifest = await fetchText(manifestUrl, signal);
  const master = parseMasterPlaylist(manifest.text, manifest.url);

  if (master.variants.length === 0) {
    const prepared = await prepareMediaPlaylist(
      manifest.text,
      manifest.url,
      `${id}-media`,
      0.08,
      0.82,
      onProgress,
      signal,
    );

    return {
      files: prepared.files,
      videoPlaylist: prepared.playlistName,
      label: "Single playlist",
    };
  }

  const variant = selectBestVariant(master.variants);
  const variantUrl = new URL(variant.uri, manifest.url).toString();
  const audio = selectAudioRendition(master.renditions, variant.audioGroupId);

  onProgress?.({ label: "Preparing video stream", progress: 0.08 });
  const videoManifest = await fetchText(variantUrl, signal);
  const video = await prepareMediaPlaylist(
    videoManifest.text,
    videoManifest.url,
    `${id}-video`,
    0.1,
    audio?.uri ? 0.46 : 0.78,
    onProgress,
    signal,
  );

  let audioPlaylist: PreparedPlaylist | undefined;
  if (audio?.uri) {
    onProgress?.({ label: "Preparing audio stream", progress: 0.58 });
    const audioUrl = new URL(audio.uri, manifest.url).toString();
    const audioManifest = await fetchText(audioUrl, signal);
    audioPlaylist = await prepareMediaPlaylist(
      audioManifest.text,
      audioManifest.url,
      `${id}-audio`,
      0.58,
      0.3,
      onProgress,
      signal,
    );
  }

  const dimensions =
    variant.width && variant.height ? `${variant.width}x${variant.height}` : "best";

  return {
    files: [...video.files, ...(audioPlaylist?.files ?? [])],
    videoPlaylist: video.playlistName,
    audioPlaylist: audioPlaylist?.playlistName,
    label: audioPlaylist
      ? `${dimensions} video + ${audioPlaylist.resourceCount} audio chunks`
      : `${dimensions} combined stream`,
  };
}

function parseMasterPlaylist(
  text: string,
  baseUrl: string,
): { variants: HlsVariant[]; renditions: HlsRendition[] } {
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-MEDIA:".length));
      renditions.push({
        type: attrs.TYPE ?? "",
        groupId: attrs["GROUP-ID"],
        name: attrs.NAME,
        uri: attrs.URI ? new URL(attrs.URI, baseUrl).toString() : undefined,
        isDefault: attrs.DEFAULT === "YES",
      });
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
      const nextUri = findNextUri(lines, index + 1);
      if (!nextUri) {
        continue;
      }

      const [width, height] = (attrs.RESOLUTION ?? "")
        .split("x")
        .map((part) => Number.parseInt(part, 10));

      variants.push({
        uri: new URL(nextUri, baseUrl).toString(),
        bandwidth: Number.parseInt(attrs.BANDWIDTH ?? "0", 10),
        width: Number.isFinite(width) ? width : undefined,
        height: Number.isFinite(height) ? height : undefined,
        audioGroupId: attrs.AUDIO,
      });
    }
  }

  return { variants, renditions };
}

async function prepareMediaPlaylist(
  text: string,
  playlistUrl: string,
  prefix: string,
  start: number,
  span: number,
  onProgress?: (progress: HlsProgress) => void,
  signal?: AbortSignal,
): Promise<PreparedPlaylist> {
  const resources: PlaylistResource[] = [];
  const namesByUrl = new Map<string, string>();
  let segmentIndex = 0;
  let resourceIndex = 0;

  const rewrittenLines = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();

    if (trimmed.startsWith("#EXT-X-MAP:")) {
      return replaceUriAttribute(trimmed, (uri) =>
        registerResource(
          new URL(uri, playlistUrl).toString(),
          `${prefix}-init${extensionFromUrl(uri, ".mp4")}`,
          resources,
          namesByUrl,
        ),
      );
    }

    if (trimmed.startsWith("#EXT-X-KEY:")) {
      return replaceUriAttribute(trimmed, (uri) => {
        resourceIndex += 1;
        return registerResource(
          new URL(uri, playlistUrl).toString(),
          `${prefix}-key-${resourceIndex}.key`,
          resources,
          namesByUrl,
        );
      });
    }

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return line;
    }

    segmentIndex += 1;
    return registerResource(
      new URL(trimmed, playlistUrl).toString(),
      `${prefix}-seg-${segmentIndex}${extensionFromUrl(trimmed, ".ts")}`,
      resources,
      namesByUrl,
    );
  });

  const files: PreparedFile[] = [];

  for (const [index, resource] of resources.entries()) {
    signal?.throwIfAborted();
    onProgress?.({
      label: `Fetching ${prefix.replaceAll("-", " ")} ${index + 1}/${resources.length}`,
      progress: start + (resources.length ? (index / resources.length) * span : 0),
    });
    files.push({
      name: resource.name,
      data: await fetchBytes(resource.url, signal),
    });
  }

  const playlistName = `${prefix}.m3u8`;
  files.push({
    name: playlistName,
    data: new TextEncoder().encode(rewrittenLines.join("\n")),
  });

  onProgress?.({
    label: `Prepared ${prefix.replaceAll("-", " ")}`,
    progress: start + span,
  });

  return { playlistName, files, resourceCount: resources.length };
}

function selectBestVariant(variants: HlsVariant[]): HlsVariant {
  return [...variants].sort((left, right) => {
    const leftPixels = (left.width ?? 0) * (left.height ?? 0);
    const rightPixels = (right.width ?? 0) * (right.height ?? 0);
    return rightPixels - leftPixels || right.bandwidth - left.bandwidth;
  })[0];
}

function selectAudioRendition(
  renditions: HlsRendition[],
  audioGroupId?: string,
): HlsRendition | undefined {
  const audioRenditions = renditions.filter(
    (rendition) =>
      rendition.type === "AUDIO" &&
      rendition.uri &&
      (!audioGroupId || rendition.groupId === audioGroupId),
  );

  return (
    audioRenditions.find((rendition) => rendition.isDefault) ??
    audioRenditions[0]
  );
}

function parseAttributeList(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value))) {
    attrs[match[1]] = stripQuotes(match[2]);
  }

  return attrs;
}

function replaceUriAttribute(
  line: string,
  replacer: (uri: string) => string,
): string {
  return line.replace(/URI="([^"]+)"/, (_match, uri: string) => {
    return `URI="${replacer(uri)}"`;
  });
}

function registerResource(
  url: string,
  fallbackName: string,
  resources: PlaylistResource[],
  namesByUrl: Map<string, string>,
): string {
  const existing = namesByUrl.get(url);
  if (existing) {
    return existing;
  }

  namesByUrl.set(url, fallbackName);
  resources.push({ url, name: fallbackName });
  return fallbackName;
}

function findNextUri(lines: string[], start: number): string | null {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    return line;
  }
  return null;
}

function extensionFromUrl(value: string, fallback: string): string {
  try {
    const pathname = new URL(value, "https://example.com").pathname;
    const match = pathname.match(/\.[a-z0-9]{2,5}$/i);
    return match?.[0] ?? fallback;
  } catch {
    return fallback;
  }
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<FetchedText> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status}`);
  }
  return { text: await response.text(), url: response.url || url };
}

async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
