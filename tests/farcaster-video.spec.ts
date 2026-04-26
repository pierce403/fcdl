import { expect, test } from "@playwright/test";

const CAST_URL = "https://farcaster.xyz/icetoad.eth/0x8ad59e91";

test("resolves and starts pulling the Icetoad Farcaster HLS video", async ({
  page,
}) => {
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

  await assetCard.getByRole("button", { name: "Download" }).click();
  await childPlaylistResponse;

  await expect(
    page.getByText(/Loading FFmpeg core|Muxing MP4|Fetching .* (video|audio)/),
  ).toBeVisible();
  await expect(page.getByText(/Failed|Could not fetch/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Cancel" }).click();
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
