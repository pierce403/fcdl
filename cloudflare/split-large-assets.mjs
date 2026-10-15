import { readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const output = resolve(process.env.CLOUDFLARE_ASSET_DIRECTORY || 'dist');
const configuration = JSON.parse(readFileSync(new URL('./large-assets.sources.json', import.meta.url), 'utf8'));
const chunkBytes = 16 * 1024 * 1024;
const files = configuration.files.map(file => {
  if (!file.path.startsWith('/') || file.path.includes('..') || file.path.includes('?') || file.path.includes('#')) throw Error('Invalid public asset path');
  const path = resolve(output, file.path.slice(1));
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const chunks = [];
  for (let start = 0, index = 0; start < bytes.length; start += chunkBytes, index++) {
    const part = bytes.subarray(start, Math.min(start + chunkBytes, bytes.length));
    const publicPath = '/cloudflare-assets/' + sha256 + '/' + String(index).padStart(4, '0') + '.bin';
    const destination = resolve(output, publicPath.slice(1));
    mkdirSync(resolve(destination, '..'), { recursive: true });
    writeFileSync(destination, part);
    chunks.push({ path: publicPath, start, bytes: part.length });
  }
  unlinkSync(path);
  return { ...file, bytes: bytes.length, sha256, chunks };
});
writeFileSync(new URL('./large-assets.generated.json', import.meta.url), JSON.stringify({ files }, null, 2) + '\n');
appendFileSync(resolve(output, '_headers'), '\n/cloudflare-assets/*\n  Cache-Control: public, max-age=31536000, immutable, no-transform\n');
console.log('Prepared', files.length, 'streamed assets without changing their public URLs or bytes.');
