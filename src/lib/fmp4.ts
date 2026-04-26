export interface Fmp4Progress {
  label: string;
  progress: number;
}

export interface Fmp4Download {
  blob: Blob;
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
  uri?: string;
  isDefault: boolean;
}

interface MediaPlaylist {
  initUrl: string;
  segmentUrls: string[];
}

interface Box {
  type: string;
  start: number;
  end: number;
  size: number;
  header: number;
}

interface FetchedText {
  text: string;
  url: string;
}

const TRACK_ID_VIDEO = 1;
const TRACK_ID_AUDIO = 2;

export async function prepareFmp4HlsDownload(
  manifestUrl: string,
  onProgress?: (progress: Fmp4Progress) => void,
  signal?: AbortSignal,
): Promise<Fmp4Download | null> {
  onProgress?.({ label: "Reading HLS manifest", progress: 0.02 });
  const manifest = await fetchText(manifestUrl, signal);
  const master = parseMasterPlaylist(manifest.text, manifest.url);

  if (master.variants.length === 0) {
    const playlist = parseMediaPlaylist(manifest.text, manifest.url);
    if (!playlist) {
      return null;
    }

    const media = await fetchMediaPlaylist(playlist, "media", 0.1, 0.82, onProgress, signal);
    const chunks = [
      patchTrackIds(media.init, TRACK_ID_VIDEO),
      ...media.segments.map((segment) => segmentPayload(segment, TRACK_ID_VIDEO)),
    ];

    return {
      blob: new Blob(chunks.map(toArrayBuffer), { type: "video/mp4" }),
      label: `${media.segments.length} fMP4 chunks`,
    };
  }

  const variant = selectBestVariant(master.variants);
  const audio = selectAudioRendition(master.renditions, variant.audioGroupId);

  const videoManifest = await fetchText(new URL(variant.uri, manifest.url).toString(), signal);
  const videoPlaylist = parseMediaPlaylist(videoManifest.text, videoManifest.url);
  if (!videoPlaylist) {
    return null;
  }

  const audioManifest = audio?.uri
    ? await fetchText(new URL(audio.uri, manifest.url).toString(), signal)
    : null;
  const audioPlaylist = audioManifest
    ? parseMediaPlaylist(audioManifest.text, audioManifest.url)
    : null;
  if (audioManifest && !audioPlaylist) {
    return null;
  }

  const videoSpan = audioPlaylist ? 0.42 : 0.74;
  const video = await fetchMediaPlaylist(
    videoPlaylist,
    "video",
    0.12,
    videoSpan,
    onProgress,
    signal,
  );

  if (!audioPlaylist) {
    const chunks = [
      patchTrackIds(video.init, TRACK_ID_VIDEO),
      ...video.segments.map((segment) => segmentPayload(segment, TRACK_ID_VIDEO)),
    ];

    return {
      blob: new Blob(chunks.map(toArrayBuffer), { type: "video/mp4" }),
      label: labelForVariant(variant, video.segments.length),
    };
  }

  const audioMedia = await fetchMediaPlaylist(
    audioPlaylist,
    "audio",
    0.58,
    0.32,
    onProgress,
    signal,
  );

  onProgress?.({ label: "Muxing fragmented MP4", progress: 0.94 });
  const chunks = [
    mergeInitSegments(video.init, audioMedia.init),
    ...interleaveFragments(video.segments, audioMedia.segments),
  ];

  return {
    blob: new Blob(chunks.map(toArrayBuffer), { type: "video/mp4" }),
    label: labelForVariant(variant, video.segments.length),
  };
}

async function fetchMediaPlaylist(
  playlist: MediaPlaylist,
  label: string,
  start: number,
  span: number,
  onProgress?: (progress: Fmp4Progress) => void,
  signal?: AbortSignal,
): Promise<{ init: Uint8Array; segments: Uint8Array[] }> {
  const total = playlist.segmentUrls.length + 1;
  const init = await fetchBytes(playlist.initUrl, signal);
  const segments: Uint8Array[] = [];

  for (const [index, url] of playlist.segmentUrls.entries()) {
    signal?.throwIfAborted();
    onProgress?.({
      label: `Fetching ${label} ${index + 1}/${playlist.segmentUrls.length}`,
      progress: start + ((index + 1) / total) * span,
    });
    segments.push(await fetchBytes(url, signal));
  }

  return { init, segments };
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

function parseMediaPlaylist(text: string, playlistUrl: string): MediaPlaylist | null {
  const mapUri = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(text)?.[1];
  if (!mapUri) {
    return null;
  }

  const segmentUrls = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => /\.mp4(?:[?#]|$)/i.test(line))
    .map((line) => new URL(line, playlistUrl).toString());

  if (segmentUrls.length === 0) {
    return null;
  }

  return {
    initUrl: new URL(mapUri, playlistUrl).toString(),
    segmentUrls,
  };
}

function mergeInitSegments(videoInit: Uint8Array, audioInit: Uint8Array): Uint8Array {
  const video = patchTrackIds(videoInit, TRACK_ID_VIDEO);
  const audio = patchTrackIds(audioInit, TRACK_ID_AUDIO);
  const videoFtyp = findBox(video, ["ftyp"]);
  const videoMoov = findBox(video, ["moov"]);
  const audioTrak = findBox(audio, ["moov", "trak"]);
  const audioTrex = findBox(audio, ["moov", "mvex", "trex"]);
  const videoTrex = findBox(video, ["moov", "mvex", "trex"]);

  if (!videoFtyp || !videoMoov || !audioTrak || !audioTrex || !videoTrex) {
    throw new Error("Unsupported fragmented MP4 init segment.");
  }

  const moovChildren = readBoxes(video, videoMoov.start + videoMoov.header, videoMoov.end);
  const moovPayloads: Uint8Array[] = [];

  for (const child of moovChildren) {
    if (child.type === "mvex") {
      moovPayloads.push(
        makeBox("mvex", [sliceBox(video, videoTrex), sliceBox(audio, audioTrex)]),
      );
      continue;
    }

    moovPayloads.push(sliceBox(video, child));
    if (child.type === "trak") {
      moovPayloads.push(sliceBox(audio, audioTrak));
    }
  }

  return concat([sliceBox(video, videoFtyp), makeBox("moov", moovPayloads)]);
}

function interleaveFragments(
  videoSegments: Uint8Array[],
  audioSegments: Uint8Array[],
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const length = Math.max(videoSegments.length, audioSegments.length);

  for (let index = 0; index < length; index += 1) {
    const videoSegment = videoSegments[index];
    const audioSegment = audioSegments[index];

    if (videoSegment) {
      chunks.push(segmentPayload(videoSegment, TRACK_ID_VIDEO));
    }
    if (audioSegment) {
      chunks.push(segmentPayload(audioSegment, TRACK_ID_AUDIO));
    }
  }

  return chunks;
}

function segmentPayload(segment: Uint8Array, trackId: number): Uint8Array {
  const patched = patchTrackIds(segment, trackId);
  return concat(
    readBoxes(patched)
      .filter((box) => box.type === "moof" || box.type === "mdat")
      .map((box) => sliceBox(patched, box)),
  );
}

function patchTrackIds(data: Uint8Array, trackId: number): Uint8Array {
  const copy = new Uint8Array(data);
  const tkhd = findBox(copy, ["moov", "trak", "tkhd"]);
  const trex = findBox(copy, ["moov", "mvex", "trex"]);

  if (tkhd) {
    writeUint32(copy, tkhd.start + 20, trackId);
  }
  if (trex) {
    writeUint32(copy, trex.start + 12, trackId);
  }

  for (const moof of readBoxes(copy).filter((box) => box.type === "moof")) {
    const trafs = readBoxes(copy, moof.start + moof.header, moof.end).filter(
      (box) => box.type === "traf",
    );
    for (const traf of trafs) {
      const tfhd = findBox(copy, ["tfhd"], traf.start + traf.header, traf.end);
      if (tfhd) {
        writeUint32(copy, tfhd.start + 12, trackId);
      }
    }
  }

  return copy;
}

function readBoxes(data: Uint8Array, start = 0, end = data.byteLength): Box[] {
  const boxes: Box[] = [];
  let offset = start;

  while (offset + 8 <= end) {
    let size = readUint32(data, offset);
    const type = readType(data, offset + 4);
    let header = 8;

    if (size === 1) {
      size = readUint64(data, offset + 8);
      header = 16;
    }
    if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) {
      break;
    }

    boxes.push({ type, start: offset, end: offset + size, size, header });
    offset += size;
  }

  return boxes;
}

function findBox(
  data: Uint8Array,
  path: string[],
  start = 0,
  end = data.byteLength,
): Box | null {
  for (const child of readBoxes(data, start, end)) {
    if (child.type !== path[0]) {
      continue;
    }
    if (path.length === 1) {
      return child;
    }
    const found = findBox(
      data,
      path.slice(1),
      child.start + child.header,
      child.end,
    );
    if (found) {
      return found;
    }
  }

  return null;
}

function makeBox(type: string, payloads: Uint8Array[]): Uint8Array {
  const size = 8 + payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  const output = new Uint8Array(size);

  writeUint32(output, 0, size);
  for (let index = 0; index < 4; index += 1) {
    output[4 + index] = type.charCodeAt(index);
  }

  let offset = 8;
  for (const payload of payloads) {
    output.set(payload, offset);
    offset += payload.byteLength;
  }

  return output;
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

function labelForVariant(variant: HlsVariant, chunks: number): string {
  const dimensions =
    variant.width && variant.height ? `${variant.width}x${variant.height}` : "best";
  return `${dimensions}, ${chunks} fMP4 chunks`;
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

function sliceBox(data: Uint8Array, box: Box): Uint8Array {
  return data.subarray(box.start, box.end);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

function readType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  );
}

function readUint32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0);
}

function readUint64(data: Uint8Array, offset: number): number {
  const high = readUint32(data, offset);
  const low = readUint32(data, offset + 4);
  return high * 2 ** 32 + low;
}

function writeUint32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset + offset, 4).setUint32(0, value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
