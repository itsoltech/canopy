/** Rebuild committed native/web assets from the unchanged stable artwork.
 * bun scripts/icons/channel-icons.ts [--previews <directory>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { releaseIdentity, type ReleaseChannel } from "@canopy/domain/release/identity";
import { channelArtwork, separateTree } from "./artwork.ts";
import { ico, icns } from "./formats.ts";
import { writePreviews } from "./previews.ts";
import { gradeTree } from "./lighting.ts";
import { mobileArtwork, type MobileArtwork } from "./mobile.ts";
import { writeMobilePreviews } from "./mobile-previews.ts";

const root = resolve(import.meta.dir, "../..");
const source = await readFile(join(root, "apps/web/static/icon-512.png"));
const tree = await separateTree(source);
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { previews: { type: "string" } }, strict: true });
const artwork = new Map<ReleaseChannel, Buffer>();
const mobile = new Map<ReleaseChannel, MobileArtwork>();

for (const channel of ["stable", "beta", "nightly"] as const) {
  const directory = join(root, "apps/web/static", releaseIdentity(channel).assets);
  await mkdir(directory, { recursive: true });
  const foreground = await gradeTree(tree, channel);
  const icon = await channelArtwork(source, tree, foreground, channel);
  artwork.set(channel, icon);

  for (const size of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024])
    await writeFile(
      join(directory, `icon-${size}.png`),
      size === 512 ? icon : await sharp(icon).resize(size).png().toBuffer(),
    );
  await writeFile(join(directory, "icon.ico"), await ico(icon));
  await writeFile(join(directory, "icon.icns"), await icns(icon));

  const native = await mobileArtwork(foreground, channel);
  mobile.set(channel, native);

  for (const [filename, input] of [
    ["expo-icon", native.icon],
    ["adaptive-foreground", native.foreground],
    ["adaptive-background", native.background],
    ["adaptive-monochrome", native.monochrome],
    ["splash", native.splash],
  ] as const)
    await writeFile(join(directory, `${filename}.png`), input);
}

if (values.previews) {
  await writePreviews(artwork, resolve(values.previews));
  await writeMobilePreviews(mobile, resolve(values.previews));
}
