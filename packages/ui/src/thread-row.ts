import { hexLuminance, normalizeColor } from "./color.ts";
import { hashString } from "./hash.ts";
import palette from "./palette.json";

/** Shared semantic working colours; the activity mark is one step lighter than text in light mode. */
export const workingColors = {
  light: { text: palette.sky[700], indicator: palette.sky[600] },
  dark: { text: palette.sky[400], indicator: palette.sky[400] },
} as const;

/** Project marks use the same pastel fill and identity on every client. Neutrals follow the owner palette. */
const projectTones = ["rose", "amber", "lime", "teal", "blue", "violet", "fuchsia", "zinc"] as const;

export function projectMark(name: string) {
  const hash = hashString(name);
  // Fold in the upper half so the palette index uses more than the three lowest bits of FNV-1a.
  const tone = projectTones[((hash ^ (hash >>> 16)) >>> 0) % projectTones.length]!;

  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();

  return {
    tone,
    initials,
    light: tone === "zinc" ? 700 : 800,
    dark: tone === "zinc" ? 300 : 400,
    fill: 500,
    opacity: 0.15,
  } as const;
}

/** Keep the exact custom fill and choose the initials color with the higher contrast. */
export function projectMarkColors(color: string) {
  const fill = normalizeColor(color);

  if (!fill) return undefined;

  // At this luminance black and white have equal contrast against the fill.
  const text = hexLuminance(fill) < 0.1791287847 ? "#ffffff" : "#000000";

  return { fill, text } as const;
}

/** Same track and quarter ring as the web spinner. Rotation is the default CSS spin cycle. */
export const threadSpinner = {
  viewBox: "0 0 16 16",
  center: 8,
  radius: 6,
  strokeWidth: 2,
  trackOpacity: 0.2,
  path: "M14 8a6 6 0 0 0-6-6",
} as const;

export const threadRowMarks = { providerOpacity: 0.7, slot: 20, icon: 16 } as const;
