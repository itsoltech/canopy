import sharp from "sharp";
import type { ReleaseChannel } from "@canopy/domain/release/identity";

type Tone = readonly [number, number, number, number];

// Luminance stops preserve the illustration's shadows, leaves and brightest leaf planes.
const moonlight: readonly Tone[] = [
  [0, 19, 45, 57],
  [0.2, 63, 106, 119],
  [0.5, 85, 154, 139],
  [0.85, 180, 211, 200],
  [1, 217, 232, 224],
];

const goldenHour: readonly Tone[] = [
  [0, 20, 40, 23],
  [0.2, 46, 66, 31],
  [0.5, 132, 153, 49],
  [0.85, 223, 207, 97],
  [1, 255, 235, 163],
];

function toneAt(luminance: number, stops: readonly Tone[], component: 1 | 2 | 3) {
  const upper = stops.findIndex((stop) => stop[0] >= luminance);
  const right = stops[Math.max(1, upper)]!;
  const left = stops[Math.max(1, upper) - 1]!;
  const mix = Math.max(0, Math.min(1, (luminance - left[0]) / (right[0] - left[0])));

  return left[component] * (1 - mix) + right[component] * mix;
}

/** Directional highlights stay inside the matte, avoiding a pale outline in the sky. */
export async function gradeTree(tree: Buffer, channel: ReleaseChannel) {
  if (channel === "stable") return tree;

  const { data, info } = await sharp(tree).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  const night = channel === "nightly";
  const stops = night ? moonlight : goldenHour;
  const light = night ? [180, 211, 217] : [255, 211, 135];

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 4;
      const alpha = data[offset + 3]! / 255;

      if (alpha === 0) continue;
      const luminance = (0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!) / 255;
      const facing = x + 2 < info.width && y > 1 ? data[((y - 2) * info.width + x + 2) * 4 + 3]! / 255 : 0;
      const rim = (1 - facing) * alpha;
      const illumination = Math.exp(-((x - 423) ** 2 + (y - 71) ** 2) / (2 * 230 ** 2));
      const amount = illumination * (night ? 0.035 : 0.065) + rim * illumination * (night ? 0.38 : 0.14);

      for (const c of [1, 2, 3] as const) {
        const graded = toneAt(luminance, stops, c);
        output[offset + c - 1] = Math.round(graded * (1 - amount) + light[c - 1]! * amount);
      }
    }
  }

  return sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Transfer the neutral source's real bevel, gloss and inner shading onto the new sky.
 * Only background pixels contribute; illustration pigments cannot stain the scene.
 */
export async function finishBackground(source: Buffer, tree: Buffer, sky: Buffer) {
  const original = await sharp(source).ensureAlpha().raw().toBuffer();
  const foreground = await sharp(tree).ensureAlpha().raw().toBuffer();
  const { data, info } = await sharp(sky).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  for (let y = 0; y < info.height; y++) {
    const baseline = 0.93 - (0.3 * y) / info.height;

    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 4;
      const coverage = foreground[offset + 3]! / 255;
      const sourceLuminance = (original[offset]! + original[offset + 1]! + original[offset + 2]!) / (3 * 255);
      const neutral = sourceLuminance * (1 - coverage) + baseline * coverage;
      const gloss = Math.max(0, neutral - baseline - 0.015) * 0.9;
      const shade = 0.55 + 0.5 * neutral;

      for (let c = 0; c < 3; c++)
        data[offset + c] = Math.round(Math.min(255, data[offset + c]! * shade * (1 - gloss) + 255 * gloss));
    }
  }

  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}
