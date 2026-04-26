# fcdl

Static React + TypeScript app for downloading video embeds from Farcaster-style cast URLs.

Paste a cast URL, direct video URL, or copied metadata blob. The app resolves hydrated Farcaster embeds in the browser, finds direct MP4/WebM/MOV files or HLS playlists, and downloads them locally. HLS playlists are remuxed to MP4 in-browser with FFmpeg WASM, including streams where video and audio are split.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The production build is static. The `dist` output can be deployed directly to GitHub Pages; the custom domain is configured through `public/CNAME`.
