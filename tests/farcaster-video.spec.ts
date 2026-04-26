import { expect, test } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";

const CAST_URL = "https://farcaster.xyz/icetoad.eth/0x8ad59e91";

test("resolves and downloads the Icetoad Farcaster HLS video", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/");

  await page
    .getByPlaceholder("https://farcaster.xyz/user/0x...")
    .fill(CAST_URL);
  await page.getByRole("button", { name: "Analyze" }).click();

  const assetCard = page
    .locator(".asset-card")
    .filter({ hasText: "icetoad-eth-0x8ad59e91.mp4" });

  await expect(assetCard).toBeVisible();
  await expect(assetCard).toContainText("Farcaster Open Graph");
  await expect(assetCard).toContainText("HLS to MP4");

  const childPlaylistResponse = page.waitForResponse(
    (response) =>
      response.ok() &&
      response.url().includes("cloudflarestream.com") &&
      /\/manifest\/stream_.*\.m3u8/.test(response.url()),
    { timeout: 75_000 },
  );

  const downloadPromise = page.waitForEvent("download", { timeout: 210_000 });

  await assetCard.getByRole("button", { name: "Download" }).click();
  await childPlaylistResponse;
  await expect(page.getByText(/Failed|Could not fetch/i)).toHaveCount(0);

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("icetoad-eth-0x8ad59e91.mp4");

  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  expect((await stat(downloadPath!)).size).toBeGreaterThan(1_000_000);

  const mp4 = await readFile(downloadPath!);
  expect(mp4.includes(Buffer.from("avc1"))).toBeTruthy();
  expect(mp4.includes(Buffer.from("mp4a"))).toBeTruthy();
  expect(countAscii(mp4, "trak")).toBeGreaterThanOrEqual(2);

  await expect(page.getByText("Complete")).toBeVisible();
});

test("publishes a large-card Open Graph preview", async ({ page, request }) => {
  await page.goto("/");

  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "fcdl - Farcaster video downloader",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://fcdl.net/og.svg",
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );

  const preview = await request.get("/og.svg");
  expect(preview.ok()).toBeTruthy();
  expect(await preview.text()).toContain("Farcaster video downloader");
});

function countAscii(buffer: Buffer, value: string): number {
  const needle = Buffer.from(value);
  let count = 0;
  let offset = 0;

  while ((offset = buffer.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }

  return count;
}
