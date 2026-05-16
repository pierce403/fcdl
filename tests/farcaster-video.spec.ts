import { expect, test, type Download, type Page } from "@playwright/test";
import { readFile, stat } from "node:fs/promises";

const CAST_URL = "https://farcaster.xyz/icetoad.eth/0x8ad59e91";

test("resolves and downloads the Icetoad Farcaster HLS video", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/");

  await expect(page.getByText("Bookmark fcdl.net")).toBeVisible();
  const downloadPromise = page.waitForEvent("download", { timeout: 210_000 });
  await pasteUrl(page, CAST_URL);

  const assetCard = page
    .locator(".asset-card")
    .filter({ hasText: "icetoad-eth-0x8ad59e91.mp4" });

  await expect(assetCard).toBeVisible();
  await expect(assetCard).toContainText("Farcaster Open Graph");
  await expect(assetCard).toContainText("HLS to MP4");
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
  const boxTypes = topLevelBoxTypes(mp4);
  expect(boxTypes.filter((type) => type === "moof")).toHaveLength(0);
  expect(boxTypes.filter((type) => type === "mdat")).toHaveLength(1);

  await expect(page.getByText("Complete")).toBeVisible();
  await expect(assetCard.getByRole("button", { name: "Done" })).toBeDisabled();
});

test("auto-downloads every video resolved from one cast", async ({ page }) => {
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  await routeMultiVideoCast(page);
  await page.goto("/");

  await pasteUrl(page, "https://farcaster.xyz/multi.eth/0xabcdef");

  await expect(page.locator(".asset-card")).toHaveCount(2);
  await expect(page.getByText("2 found")).toBeVisible();
  await expect
    .poll(() => downloads.map((download) => download.suggestedFilename()).sort(), {
      timeout: 15_000,
    })
    .toEqual(["multi-eth-0xabcdef-2.mp4", "multi-eth-0xabcdef.mp4"]);

  for (const download of downloads) {
    const path = await download.path();
    expect(path).toBeTruthy();
    expect((await stat(path!)).size).toBeGreaterThan(8);
  }
});

test("publishes a large-card Open Graph preview", async ({ page, request }) => {
  await page.goto("/");

  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "fcdl - Farcaster video downloader",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://fcdl.net/og.png",
  );
  await expect(page.locator('meta[property="og:image:type"]')).toHaveAttribute(
    "content",
    "image/png",
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );

  const preview = await request.get("/og.png");
  expect(preview.ok()).toBeTruthy();
  expect(preview.headers()["content-type"]).toContain("image/png");
  expect((await preview.body()).byteLength).toBeGreaterThan(20_000);
});

async function pasteUrl(page: Page, url: string): Promise<void> {
  await page
    .getByPlaceholder("https://farcaster.xyz/user/0x...")
    .evaluate((textarea, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    }, url);
}

async function routeMultiVideoCast(page: Page): Promise<void> {
  await page.route("https://farcaster.tv/multi.eth/0xabcdef", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      json: {
        result: {
          casts: [
            {
              hash: "0xabcdef",
              text: "two videos",
              author: {
                displayName: "Multi",
                username: "multi.eth",
              },
              embeds: {
                videos: [
                  {
                    sourceUrl: "http://127.0.0.1:5173/fixtures/clip-one.mp4",
                    thumbnailUrl: "",
                    width: 640,
                    height: 360,
                  },
                  {
                    sourceUrl: "http://127.0.0.1:5173/fixtures/clip-two.mp4",
                    thumbnailUrl: "",
                    width: 640,
                    height: 360,
                  },
                ],
              },
            },
          ],
        },
      },
    });
  });

  await page.route("http://127.0.0.1:5173/fixtures/clip-one.mp4", async (route) => {
    await route.fulfill({
      contentType: "video/mp4",
      body: Buffer.from("fake mp4 clip one"),
    });
  });

  await page.route("http://127.0.0.1:5173/fixtures/clip-two.mp4", async (route) => {
    await route.fulfill({
      contentType: "video/mp4",
      body: Buffer.from("fake mp4 clip two"),
    });
  });
}

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

function topLevelBoxTypes(buffer: Buffer): string[] {
  const types: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > buffer.byteLength) {
        break;
      }
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    }
    if (size === 0) {
      size = buffer.byteLength - offset;
    }
    if (size < headerSize || offset + size > buffer.byteLength) {
      break;
    }

    types.push(type);
    offset += size;
  }

  return types;
}
