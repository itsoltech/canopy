import { normalizeColor } from "./color.ts";

type Oklab = readonly [lightness: number, a: number, b: number];

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function byteFromLinear(channel: number): string {
  const value = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}

function hexToOklab(color: string): Oklab {
  const channel = (index: number) => toLinear(Number.parseInt(color.slice(index, index + 2), 16) / 255);
  const red = channel(1);
  const green = channel(3);
  const blue = channel(5);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function hexFromOklab(lightness: number, a: number, b: number): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const red = byteFromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = byteFromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = byteFromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

  return `#${red}${green}${blue}`;
}

export function hexFromOklch(lightness: number, chroma: number, hue: number): string {
  const radians = (hue * Math.PI) / 180;

  return hexFromOklab(lightness, chroma * Math.cos(radians), chroma * Math.sin(radians));
}

/** Built-in status shades mix two hex colors in Oklab. Resolve those for the hex editor. */
export function defaultThemeTokenHex(value: string): string {
  const hex = normalizeColor(value);

  if (hex) return hex;
  const [, color, weight, tint] = /^color-mix\(in oklab, (#[\da-f]{6}) (\d+)%, (#[\da-f]{6})\)$/i.exec(value) ?? [];

  if (!color || !weight || !tint) return "#000000";
  const [l, a, b] = hexToOklab(color);
  const [tintL, tintA, tintB] = hexToOklab(tint);
  const amount = Number(weight) / 100;
  const mix = (base: number, target: number) => base * amount + target * (1 - amount);

  return hexFromOklab(mix(l, tintL), mix(a, tintA), mix(b, tintB));
}
