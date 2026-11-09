/** Rebuild committed native/web assets from the unchanged stable artwork.
 * bun scripts/icons/channel-icons.ts [--previews <directory>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { releaseIdentity, type ReleaseChannel } from "@canopy/domain/release/identity";
import { channelArtwork, separateTree, sky } from "./artwork.ts";
import { ico, icns } from "./formats.ts";
import { writePreviews } from "./previews.ts";
import { gradeTree } from "./lighting.ts";

const root = resolve(import.meta.dir, "../..");
const source = await readFile(join(root, "apps/web/static/icon-512.png"));
const tree = await separateTree(source);
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { previews: { type: "string" } }, strict: true });
const artwork = new Map<ReleaseChannel, Buffer>();

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

  // iOS icons are opaque squares; the OS supplies the final rounded mask.
  const background =
    channel === "stable"
      ? await sharp({ create: { width: 512, height: 512, channels: 4, background: "#ffffff" } })
          .png()
          .toBuffer()
      : await sharp(sky(channel)).png().toBuffer();

  await sharp(background)
    .composite([{ input: icon }])
    .resize(1024)
    .flatten()
    .png()
    .toFile(join(directory, "expo-icon.png"));
  // Android foreground fits its central safe zone; launchers choose their own mask.
  await sharp(foreground)
    .resize(640)
    .extend({ top: 192, bottom: 192, left: 192, right: 192, background: "#00000000" })
    .png()
    .toFile(join(directory, "adaptive-foreground.png"));
  await sharp(background).resize(1024).png().toFile(join(directory, "adaptive-background.png"));
}

if (values.previews) await writePreviews(artwork, resolve(values.previews));
