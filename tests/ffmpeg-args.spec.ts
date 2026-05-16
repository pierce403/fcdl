import { expect, test } from "@playwright/test";
import { buildMuxArgs } from "../src/lib/ffmpegArgs";

test("muxes separate HLS audio into an iOS-compatible MP4", () => {
  expect(buildMuxArgs("video.m3u8", "audio.m3u8", "out.mp4")).toEqual([
    "-hide_banner",
    "-y",
    "-protocol_whitelist",
    "file,crypto,data",
    "-allowed_extensions",
    "ALL",
    "-i",
    "video.m3u8",
    "-protocol_whitelist",
    "file,crypto,data",
    "-allowed_extensions",
    "ALL",
    "-i",
    "audio.m3u8",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0?",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-brand",
    "mp42",
    "-avoid_negative_ts",
    "make_zero",
    "out.mp4",
  ]);
});

test("uses the same MP4 compatibility flags for combined HLS playlists", () => {
  expect(buildMuxArgs("media.m3u8", undefined, "out.mp4")).toEqual([
    "-hide_banner",
    "-y",
    "-protocol_whitelist",
    "file,crypto,data",
    "-allowed_extensions",
    "ALL",
    "-i",
    "media.m3u8",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-brand",
    "mp42",
    "-avoid_negative_ts",
    "make_zero",
    "out.mp4",
  ]);
});
