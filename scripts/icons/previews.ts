import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { AppChannel } from "@canopy/domain/release/identity";

export async function writePreviews(artwork: Map<AppChannel, Buffer>, directory: string) {
  await mkdir(directory, { recursive: true });
  const sheet: OverlayOptions[] = [];
  const dock: OverlayOptions[] = [];
  const smallDock: OverlayOptions[] = [];
  let column = 0;

  for (const [channel, icon] of artwork) {
    for (const [size, offset] of [
      [512, 0],
      [128, 0],
      [64, 144],
      [32, 224],
      [16, 272],
    ] as const) {
      const png = await sharp(icon).resize(size).png().toBuffer();
      await writeFile(join(directory, `${channel}-${size}.png`), png);
      sheet.push({ input: png, left: column * 560 + 24 + offset, top: size === 512 ? 64 : 600 + (128 - size) / 2 });
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

  const sheetWidth = artwork.size * 560;

  const labels = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="760">
    <g font-family="sans-serif" font-size="24" fill="#e4e4e7">${[...artwork.keys()]
      .map((channel, i) => `<text x="${i * 560 + 24}" y="40">Canopy · ${channel}</text>`)
      .join("")}</g></svg>`);

  await sharp({ create: { width: sheetWidth, height: 760, channels: 4, background: "#18181b" } })
    .composite([...sheet, { input: labels }])
    .png()
    .toFile(join(directory, "side-by-side.png"));

  const dockWidth = artwork.size * 200;

  const chrome = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${dockWidth}" height="320">
    <rect width="${dockWidth}" height="160" fill="#e8e8ed"/><rect y="160" width="${dockWidth}" height="160" fill="#14141b"/>
    <rect x="20" y="48" width="${dockWidth - 40}" height="96" rx="24" fill="#ffffff" fill-opacity=".65" stroke="#d4d4dc"/>
    <rect x="20" y="184" width="${dockWidth - 40}" height="96" rx="24" fill="#393940" fill-opacity=".8" stroke="#53535d"/>
    <g font-family="sans-serif" font-size="13">${[...artwork.keys()]
      .map(
        (channel, i) =>
          `<text x="${48 + i * 200}" y="34" fill="#27272a">Canopy · ${channel}</text>
       <text x="${48 + i * 200}" y="307" fill="#e4e4e7">Canopy · ${channel}</text>`,
      )
      .join("")}</g></svg>`);

  await sharp(chrome).composite(dock).png().toFile(join(directory, "dock-light-dark.png"));
  await sharp(chrome).composite(smallDock).png().toFile(join(directory, "dock-small-light-dark.png"));
}
