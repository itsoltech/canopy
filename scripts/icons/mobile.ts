import sharp, { type Sharp } from "sharp";
import { nativeLayers } from "./artwork.ts";

function monochrome(image: Sharp) {
  // Set RGB to white and keep every alpha value, including anti-aliased edges and cutouts.
  return image.linear([0, 0, 0, 1], [255, 255, 255, 0]).png().toBuffer();
}

export async function mobileArtwork(master: Buffer) {
  const { fullBleed, foreground, background, tree } = nativeLayers(master);
  // iOS supplies the corner mask for native apps and Apple touch icons.
  const square = sharp(fullBleed).removeAlpha();
  const adaptive = await sharp(foreground).resize(1024).png().toBuffer();

  const splash = await sharp(tree, { density: 576 })
    .trim({ background: "#00000000", threshold: 0 })
    .resize({ width: 512, height: 512, fit: "contain", background: "#00000000" })
    .png()
    .toBuffer();

  return {
    icon: await square.clone().resize(1024).png().toBuffer(),
    appleTouch: await square.resize(180).png().toBuffer(),
    foreground: adaptive,
    background: await sharp(background).resize(1024).removeAlpha().png().toBuffer(),
    monochrome: await monochrome(sharp(adaptive)),
    splash,
  };
}

export type MobileArtwork = Awaited<ReturnType<typeof mobileArtwork>>;

export function notificationIcon(splash: Buffer) {
  return monochrome(sharp(splash).resize(84).extend({ top: 6, bottom: 6, left: 6, right: 6, background: "#00000000" }));
}
