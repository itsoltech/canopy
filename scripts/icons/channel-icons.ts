/** Rebuild the application icons from the approved SVG masters.
 * bun scripts/icons/channel-icons.ts [--previews <directory>]
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { appIdentity, type AppChannel } from "@canopy/domain/release/identity";
import { ico, icns } from "./formats.ts";
import { mobileArtwork, notificationIcon, type MobileArtwork } from "./mobile.ts";
import { writeMobilePreviews } from "./mobile-previews.ts";
import { writePreviews } from "./previews.ts";

const root = resolve(import.meta.dir, "../..");
const web = join(root, "apps/web/static");
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { previews: { type: "string" } }, strict: true });
const artwork = new Map<AppChannel, Buffer>();
const mobile = new Map<AppChannel, MobileArtwork>();

for (const channel of ["stable", "beta", "nightly", "development"] as const) {
  const name = channel === "development" ? "dev" : channel;
  const master = await readFile(join(root, "design/brand/app-icons", `canopy-${name}.svg`));
  const directory = join(web, appIdentity(channel).assets);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "icon.svg"), master);

  for (const size of [16, 32, 48, 64, 128, 192, 256, 512, 1024])
    await sharp(master)
      .resize(size)
      .png()
      .toFile(join(directory, `icon-${size}.png`));

  await writeFile(join(directory, "icon.ico"), await ico(master));
  await writeFile(join(directory, "icon.icns"), await icns(master));

  const native = await mobileArtwork(master);

  for (const [filename, input] of [
    ["icon-180", native.appleTouch],
    ["expo-icon", native.icon],
    ["adaptive-foreground", native.foreground],
    ["adaptive-background", native.background],
    ["adaptive-monochrome", native.monochrome],
    ["splash", native.splash],
  ] as const)
    await writeFile(join(directory, `${filename}.png`), input);

  if (channel === "stable") {
    for (const [from, to] of [
      ["icon-192.png", "icon-192.png"],
      ["icon-512.png", "icon-512.png"],
      ["icon-64.png", "canopy-logo.png"],
      ["icon-180.png", "apple-touch-icon.png"],
      ["icon-16.png", "favicon-16.png"],
      ["icon-32.png", "favicon-32.png"],
      ["icon.ico", "favicon.ico"],
    ] as const)
      await copyFile(join(directory, from), join(web, to));

    const assets = join(root, "apps/mobile/assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "notification-icon.png"), await notificationIcon(native.splash));
  }

  if (values.previews) {
    artwork.set(channel, master);
    mobile.set(channel, native);
  }
}

if (values.previews) {
  await writePreviews(artwork, resolve(values.previews));
  await writeMobilePreviews(mobile, resolve(values.previews));
}
