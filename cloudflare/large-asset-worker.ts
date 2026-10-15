import manifest from './large-assets.generated.json';

const files = new Map(manifest.files.map(file => [file.path, file]));

function requestedRange(value: string | null, size: number): [number, number] | null | 'invalid' {
  if (!value || !value.startsWith('bytes=')) return null;
  // Multiple ranges may be ignored by a server; serve the complete representation.
  if (value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return 'invalid';
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'invalid';
  return [start, Math.min(end, size - 1)];
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const file = files.get(url.pathname);
    if (!file) return env.ASSETS.fetch(request);
    const etag = '"sha256-' + file.sha256 + '"';
    const headers = new Headers({
      'Content-Type': file.contentType,
      'Cache-Control': 'public, max-age=600, no-transform',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag, Accept-Ranges',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
    });
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Range, If-Range, If-None-Match');
      return new Response(null, { status: 204, headers });
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      headers.set('Allow', 'GET, HEAD, OPTIONS');
      return new Response(null, { status: 405, headers });
    }
    const matches = request.headers.get('If-None-Match')?.split(',').some(value => {
      const candidate = value.trim().replace(/^W\//, '');
      return candidate === '*' || candidate === etag;
    });
    if (matches) return new Response(null, { status: 304, headers });
    const ifRange = request.headers.get('If-Range');
    const range = requestedRange(ifRange && ifRange !== etag ? null : request.headers.get('Range'), file.bytes);
    if (range === 'invalid') {
      headers.set('Content-Range', 'bytes */' + file.bytes);
      return new Response(null, { status: 416, headers });
    }
    const [start, end] = range || [0, file.bytes - 1];
    const length = end - start + 1;
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${file.bytes}`);
    headers.set('Content-Length', String(length));
    if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });

    const segments = file.chunks.filter(chunk => chunk.start <= end && chunk.start + chunk.bytes > start);
    const settled = await Promise.allSettled(segments.map(async chunk => {
      const first = Math.max(0, start - chunk.start);
      const last = Math.min(chunk.bytes - 1, end - chunk.start);
      const chunkUrl = new URL(chunk.path, url.origin);
      const response = await env.ASSETS.fetch(new Request(chunkUrl, {
        headers: { Range: `bytes=${first}-${last}`, 'Accept-Encoding': 'identity' },
      }));
      const expectedLength = last - first + 1;
      const contentLength = response.headers.get('Content-Length');
      const partial = response.status === 206;
      if (!response.body || ![200, 206].includes(response.status) ||
          (partial && response.headers.get('Content-Range') !== `bytes ${first}-${last}/${chunk.bytes}`) ||
          (contentLength !== null && Number(contentLength) !== (partial ? expectedLength : chunk.bytes))) {
        console.error(JSON.stringify({ event: 'static_asset_segment_unavailable', path: chunk.path, status: response.status }));
        await response.body?.cancel();
        throw new Error('Static asset segment unavailable');
      }
      return { response, skip: partial ? 0 : first, take: expectedLength };
    }));
    const responses = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    if (responses.length !== segments.length) {
      await Promise.all(responses.map(segment => segment.response.body?.cancel()));
      return new Response('Asset temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } });
    }

    const { readable, writable } = new FixedLengthStream(length);
    const writer = writable.getWriter();
    const pipeline = (async () => {
      try {
        for (const segment of responses) {
          const reader = segment.response.body!.getReader();
          let skip = segment.skip;
          let remaining = segment.take;
          try {
            while (remaining > 0) {
              const next = await reader.read();
              if (next.done) throw new Error('Static asset segment ended early');
              const offset = Math.min(skip, next.value.byteLength);
              skip -= offset;
              const count = Math.min(remaining, next.value.byteLength - offset);
              if (count > 0) {
                await writer.write(next.value.subarray(offset, offset + count));
                remaining -= count;
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => {});
        await Promise.allSettled(responses.map(segment => segment.response.body?.cancel()));
        console.error(JSON.stringify({ event: 'large_asset_stream_failed', path: file.path }));
      }
    })();
    ctx.waitUntil(pipeline);
    return new Response(readable, { status: range ? 206 : 200, headers });
  },
} satisfies ExportedHandler<Env>;
