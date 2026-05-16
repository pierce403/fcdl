const HLS_INPUT_FLAGS = [
  "-protocol_whitelist",
  "file,crypto,data",
  "-allowed_extensions",
  "ALL",
];

const IOS_COMPATIBLE_MP4_FLAGS = [
  "-movflags",
  "+faststart",
  "-brand",
  "mp42",
  "-avoid_negative_ts",
  "make_zero",
];

export function buildMuxArgs(
  videoPlaylist: string,
  audioPlaylist: string | undefined,
  outputName: string,
): string[] {
  const args = ["-hide_banner", "-y", ...HLS_INPUT_FLAGS, "-i", videoPlaylist];

  if (audioPlaylist) {
    args.push(...HLS_INPUT_FLAGS, "-i", audioPlaylist);
    args.push("-map", "0:v:0", "-map", "1:a:0?", "-c", "copy");
  } else {
    args.push("-c", "copy");
  }

  args.push(...IOS_COMPATIBLE_MP4_FLAGS, outputName);
  return args;
}
