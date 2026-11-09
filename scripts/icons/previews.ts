import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { releaseIdentity, type ReleaseChannel } from "@canopy/domain/release/identity";

export async function writePreviews(artwork: Map<ReleaseChannel, Buffer>, directory: string) {
  await mkdir(directory, { recursive: true });
  const sheet: OverlayOptions[] = [];
  const dock: OverlayOptions[] = [];
  const smallDock: OverlayOptions[] = [];
  let column = 0;

  for (const [channel, icon] of artwork) {
    for (const size of [512, 128, 64, 32, 16]) {
      const png = await sharp(icon).resize(size).png().toBuffer();
      await writeFile(join(directory, `${channel}-${size}.png`), png);
      sheet.push({ input: png, left: column * 560 + 24, top: size === 512 ? 64 : 600 + (128 - size) / 2 });
    }

    for (const top of [64, 200])
      dock.push({ input: await sharp(icon).resize(64).png().toBuffer(), left: 48 + column * 200, top });

    for (const [top, size] of [
      [70, 32],
      [78, 16],
      [206, 32],
      [214, 16],
    ] as const)
      smallDock.push({
        input: await sharp(icon).resize(size).png().toBuffer(),
        left: 48 + column * 200 + (size === 16 ? 52 : 0),
        top,
      });
    column++;
  }

  // Individual reductions above are the authoritative real-size previews.
  const labels = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1680" height="760">
    <g font-family="sans-serif" font-size="24" fill="#e4e4e7">${[...artwork.keys()]
      .map((channel, i) => `<text x="${i * 560 + 24}" y="40">${releaseIdentity(channel).displayName}</text>`)
      .join("")}</g></svg>`);

  // Place reductions in a row, preserving their native pixel sizes.
  for (let i = 0; i < sheet.length; i++) {
    const size = [512, 128, 64, 32, 16][i % 5]!;
    const previousWidth = [0, 0, 144, 224, 272][i % 5]!;
    sheet[i]!.left = Math.floor(i / 5) * 560 + 24 + previousWidth;

    if (size === 512) sheet[i]!.top = 64;
  }

  await sharp({ create: { width: 1680, height: 760, channels: 4, background: "#18181b" } })
    .composite([...sheet, { input: labels }])
    .png()
    .toFile(join(directory, "side-by-side.png"));

  const chrome = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="680" height="320">
    <rect width="680" height="160" fill="#e8e8ed"/><rect y="160" width="680" height="160" fill="#14141b"/>
    <rect x="20" y="48" width="640" height="96" rx="24" fill="#ffffff" fill-opacity=".65" stroke="#d4d4dc"/>
    <rect x="20" y="184" width="640" height="96" rx="24" fill="#393940" fill-opacity=".8" stroke="#53535d"/>
    <g font-family="sans-serif" font-size="13">${[...artwork.keys()]
      .map(
        (channel, i) =>
          `<text x="${48 + i * 200}" y="34" fill="#27272a">${releaseIdentity(channel).displayName}</text>
       <text x="${48 + i * 200}" y="307" fill="#e4e4e7">${releaseIdentity(channel).displayName}</text>`,
      )
      .join("")}</g></svg>`);

  await sharp(chrome).composite(dock).png().toFile(join(directory, "dock-light-dark.png"));
  await sharp(chrome).composite(smallDock).png().toFile(join(directory, "dock-small-light-dark.png"));
}
