import sharp from "sharp";
import type { ReleaseChannel } from "@canopy/domain/release/identity";

const canvas = 1024;

/** Mobile scenes have no baked-in mask, bevel or gloss. Decorations stay clear of
 * the tree and inside launcher masks (Android displays the central 72/108 area).
 */
export function mobileScene(channel: ReleaseChannel, adaptive = false) {
  const colors = {
    stable: ["#e9edef", "#a5ad9f"],
    beta: ["#956183", "#f6bc86"],
    nightly: ["#0b1732", "#30386b"],
  }[channel];

  const x = adaptive ? 704 : 810;
  const y = adaptive ? 266 : 154;
  const radius = adaptive ? 22 : 44;

  const stars = adaptive
    ? [
        [375, 260],
        [455, 205],
        [276, 410],
      ]
    : [
        [224, 120],
        [365, 76],
        [670, 88],
        [866, 280],
        [150, 240],
      ];

  const decoration =
    channel === "stable"
      ? ""
      : channel === "beta"
        ? `<circle cx="${x}" cy="${y}" r="${radius}" fill="#ffe5b0" opacity=".9"/>`
        : `<path d="M${x} ${y - radius}a${radius} ${radius} 0 1 0 ${radius * 0.87} ${radius * 1.52} ${radius} ${radius} 0 0 1-${radius * 0.87}-${radius * 1.52}" fill="#d9e7eb"/>
      <g fill="#c2d8e5">${stars.map(([cx, cy], i) => `<circle cx="${cx}" cy="${cy}" r="${i % 2 ? 3 : 4}"/>`).join("")}</g>`;

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <defs><linearGradient id="sky" x2=".25" y2="1"><stop stop-color="${colors[0]}"/>
    <stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
    <path fill="url(#sky)" d="M0 0h1024v1024H0z"/>${decoration}</svg>`);
}

export async function treeGeometry(tree: Buffer) {
  const { data, info } = await sharp(tree).extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (!data[y * info.width + x]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }

  let radius = 0;

  for (let y = top; y <= bottom; y++)
    for (let x = left; x <= right; x++)
      if (data[y * info.width + x])
        radius = Math.max(radius, Math.hypot(x - (left + right) / 2, y - (top + bottom) / 2));

  return { left, top, width: right - left + 1, height: bottom - top + 1, radius };
}

export async function mobileArtwork(tree: Buffer, channel: ReleaseChannel) {
  const bounds = await treeGeometry(tree);

  const cropped = await sharp(tree)
    .extract({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    .png()
    .toBuffer();

  const iosTree = await sharp(cropped)
    .resize(Math.round(canvas * 0.7))
    .png()
    .toBuffer();

  const iosSize = await sharp(iosTree).metadata();

  const icon = await sharp(mobileScene(channel))
    .composite([
      {
        input: iosTree,
        left: Math.round((canvas - iosSize.width!) / 2),
        top: Math.round(canvas * 0.48 - iosSize.height! / 2),
      },
    ])
    .removeAlpha()
    .png()
    .toBuffer();

  // Fit the silhouette inside Android's 66 dp safe circle on a 108 dp canvas,
  // with 3 px for resampling. Reduce it another 14% so launcher masks leave
  // at least 8% of their visible diameter between the tree and every edge.
  const scale = (((canvas * 33) / 108 - 3) / bounds.radius) * 0.86;

  const adaptiveTree = await sharp(cropped)
    .resize(Math.floor(bounds.width * scale))
    .png()
    .toBuffer();

  const foreground = await sharp({ create: { width: canvas, height: canvas, channels: 4, background: "#00000000" } })
    .composite([{ input: adaptiveTree, gravity: "centre" }])
    .png()
    .toBuffer();

  const alpha = await sharp(foreground).extractChannel("alpha").toBuffer();

  const monochrome = await sharp({ create: { width: canvas, height: canvas, channels: 3, background: "#ffffff" } })
    .joinChannel(alpha)
    .png()
    .toBuffer();

  return {
    icon,
    foreground,
    background: await sharp(mobileScene(channel, true)).removeAlpha().png().toBuffer(),
    monochrome,
    splash: await sharp(cropped)
      .resize({ width: 512, height: 512, fit: "contain", background: "#00000000" })
      .png()
      .toBuffer(),
  };
}

export type MobileArtwork = Awaited<ReturnType<typeof mobileArtwork>>;
