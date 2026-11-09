import sharp from "sharp";
import type { ReleaseChannel } from "@canopy/domain/release/identity";
import { finishBackground } from "./lighting.ts";

const size = 512;

export function sky(channel: ReleaseChannel) {
  const colors = channel === "nightly" ? ["#0b1732", "#30386b"] : ["#956183", "#f6bc86"];

  const decoration =
    channel === "nightly"
      ? `<path d="M421 42a23 23 0 1 0 20 35 23 23 0 0 1-20-35" fill="#d9e7eb"/>
       <g fill="#c2d8e5"><circle cx="92" cy="73" r="3"/><circle cx="143" cy="39" r="2"/>
       <circle cx="369" cy="38" r="2"/><circle cx="465" cy="116" r="2.5"/>
       <path d="m66 119 2-6 2 6 6 2-6 2-2 6-2-6-6-2z"/></g>`
      : `<circle cx="423" cy="71" r="22" fill="#ffe5b0" opacity=".9"/>`;

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <defs><linearGradient id="sky" x2=".25" y2="1"><stop stop-color="${colors[0]}"/>
    <stop offset="1" stop-color="${colors[1]}"/></linearGradient>
    <radialGradient id="light" cx=".83" cy=".14" r=".7"><stop stop-color="${channel === "nightly" ? "#8aaec3" : "#ffe0a4"}" stop-opacity="${channel === "nightly" ? ".08" : ".22"}"/><stop offset="1" stop-opacity="0"/></radialGradient></defs>
    <path fill="url(#sky)" d="M0 0h512v512H0z"/><path fill="url(#light)" d="M0 0h512v512H0z"/>${decoration}</svg>`);
}

/** The source backdrop is almost neutral; tree pigments have much higher chroma.
 * Smooth the key, remove isolated mask pixels and unmatte edge RGB against each row's
 * sampled backdrop before compositing. This removes the pale fringe on a dark sky.
 */
export async function separateTree(source: Buffer) {
  const pixels = await sharp(source).ensureAlpha().raw().toBuffer();
  const mask = Buffer.alloc(size * size);

  for (let i = 0; i < mask.length; i++) {
    const r = pixels[i * 4]!;
    const g = pixels[i * 4 + 1]!;
    const b = pixels[i * 4 + 2]!;
    const high = Math.max(r, g, b);
    const saturation = high === 0 ? 0 : (high - Math.min(r, g, b)) / high;
    const luminance = (r + g + b) / 3;
    const keyed = Math.max(0, Math.min(1, (saturation - 0.12) / 0.22));
    mask[i] = Math.round(255 * keyed * (luminance < 245 ? 1 : 0));
  }

  const cleaned = await sharp(mask, { raw: { width: size, height: size, channels: 1 } })
    .median(3)
    .blur(0.3)
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const tree = Buffer.from(pixels);

  for (let y = 0; y < size; y++) {
    // The outer columns contain no tree, including at its widest canopy.
    const sampleX = y < 65 || y > 450 ? 128 : 32;
    const background = (y * size + sampleX) * 4;

    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const alpha = cleaned[y * size + x]! / 255;

      for (let c = 0; c < 3; c++)
        tree[offset + c] =
          alpha > 0
            ? Math.round(
                Math.max(0, Math.min(255, (pixels[offset + c]! - (1 - alpha) * pixels[background + c]!) / alpha)),
              )
            : 0;
      tree[offset + 3] = Math.round(alpha * pixels[offset + 3]!);
    }
  }

  return sharp(tree, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
}

export async function channelArtwork(source: Buffer, tree: Buffer, foreground: Buffer, channel: ReleaseChannel) {
  if (channel === "stable") return source;

  const silhouette = await sharp(source).extractChannel(3).raw().toBuffer();
  const background = await finishBackground(source, tree, sky(channel));

  const painted = await sharp(background)
    .composite([{ input: foreground }])
    .removeAlpha()
    .raw()
    .toBuffer();

  return sharp(painted, { raw: { width: size, height: size, channels: 3 } })
    .joinChannel(silhouette, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toBuffer();
}
