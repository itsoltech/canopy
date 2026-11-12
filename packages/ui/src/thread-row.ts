import palette from "./palette.json";

/** Shared semantic working colours; the activity mark is one step lighter than text in light mode. */
export const workingColors = {
  light: { text: palette.sky[700], indicator: palette.sky[600] },
  dark: { text: palette.sky[400], indicator: palette.sky[400] },
} as const;

/** Project marks use the same pastel fill and identity on every client. Neutrals follow the owner palette. */
const projectTones = ["emerald", "rose", "amber", "sky", "violet", "fuchsia", "cyan", "lime", "zinc"] as const;

export function projectMark(name: string) {
  const tone =
    projectTones[[...name].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) >>> 0, 7) % projectTones.length]!;

  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();

  return { tone, initials, light: 700, dark: tone === "zinc" ? 300 : 400, fill: 500, opacity: 0.15 } as const;
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
