import { normalizeColor } from "../mascot.ts";

export function hsvToHex(hue: number, saturation: number, value: number): string {
  const h = ((hue % 360) + 360) % 360 / 60;
  const c = value / 100 * saturation / 100;
  const x = c * (1 - Math.abs(h % 2 - 1));
  const m = value / 100 - c;
  const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return `#${rgb.map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToHsv(color: string): { hue: number; saturation: number; value: number } {
  const hex = normalizeColor(color) ?? "#f97316";
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const h = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (h * 60 + 360) % 360, saturation: max === 0 ? 0 : delta / max * 100, value: max * 100 };
}
