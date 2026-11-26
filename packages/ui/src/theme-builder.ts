import { normalizeColor } from "./color.ts";

export { defaultThemeTokenHex } from "./theme-color-math.ts";

const semanticLabels = {
  canvas: "Page background",
  surface: "Surface",
  panel: "Sidebar",
  hover: "Hover background",
  ink: "Text",
  muted: "Secondary text",
  border: "Border",
  accent: "Accent",
  action: "Primary button",
  "action-hover": "Primary button hover",
  "on-accent": "Primary button text",
  "on-control": "Selected control mark",
};

export type ThemeSemanticToken = keyof typeof semanticLabels;

export const neutralSteps = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950, 1000] as const;
export const toneSteps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

const statusLabels = {
  emerald: "Success",
  amber: "Waiting",
  rose: "Error",
  sky: "Info",
  orange: "Interrupted",
  violet: "Agent activity",
};

// SAFETY: the keys of these fixed label tables are exactly their declared token names.
const semantics = Object.keys(semanticLabels) as ThemeSemanticToken[];

// SAFETY: the keys of the fixed status label table are the only status palettes.
export const themeStatusTones = Object.keys(statusLabels) as (keyof typeof statusLabels)[];

export type ThemeTokenName =
  | ThemeSemanticToken
  | `zinc-${(typeof neutralSteps)[number]}`
  | `${"brand" | (typeof themeStatusTones)[number]}-${(typeof toneSteps)[number]}`;

export type ThemeColors = Readonly<Partial<Record<ThemeTokenName, string>>>;

export const cornerRadiusNames = ["square", "default", "rounded"] as const;
export const themeSpacingNames = ["compact", "default", "spacious"] as const;

export interface ThemeBuilderPatch {
  light?: ThemeColors;
  dark?: ThemeColors;
  cornerRadius?: (typeof cornerRadiusNames)[number];
  spacing?: (typeof themeSpacingNames)[number];
}

export const themeColorGroups = [
  { label: "Interface colors", tokens: semantics },
  { label: "Neutral shades", tokens: neutralSteps.map((step) => `zinc-${step}` as const) },
  { label: "Accent shades", tokens: toneSteps.map((step) => `brand-${step}` as const) },
  ...themeStatusTones.map((tone) => ({
    label: statusLabels[tone],
    tokens: toneSteps.map((step) => `${tone}-${step}` as const),
  })),
] satisfies readonly { label: string; tokens: readonly ThemeTokenName[] }[];

/** Keep existing positions stable for saved themes and links. */
export const themeTokenNames: readonly ThemeTokenName[] = themeColorGroups.flatMap<ThemeTokenName>(
  ({ tokens }) => tokens,
);

function isSemanticToken(token: ThemeTokenName): token is ThemeSemanticToken {
  return semantics.some((name) => name === token);
}

export function themeTokenLabel(token: ThemeTokenName): string {
  return isSemanticToken(token) ? semanticLabels[token] : token.slice(token.lastIndexOf("-") + 1);
}

/** Two base-36 index characters followed by six hex characters per saved color. */
export function packThemeColors(colors: ThemeColors): string {
  return themeTokenNames
    .map((token, index) => {
      const value = colors[token];
      const color = value && normalizeColor(value);

      return color ? index.toString(36).padStart(2, "0") + color.slice(1) : "";
    })
    .join("");
}

export function unpackThemeColors(value: string): ThemeColors | undefined {
  if (value.length % 8 || value.length > themeTokenNames.length * 8) return undefined;
  const colors: Partial<Record<ThemeTokenName, string>> = {};

  for (let index = 0; index < value.length; index += 8) {
    const entry = value.slice(index, index + 8);

    if (!/^[0-9a-z]{2}[0-9a-f]{6}$/.test(entry)) return undefined;
    const token = themeTokenNames[Number.parseInt(entry.slice(0, 2), 36)];

    if (!token || colors[token]) return undefined;
    colors[token] = "#" + entry.slice(2);
  }

  return colors;
}

/** The proposal URL is bounded even when both palettes use every available token. */
export function encodeThemeBuilderPatch(patch: ThemeBuilderPatch): string {
  return [
    "1",
    patch.cornerRadius ?? "",
    patch.spacing ?? "",
    patch.light ? packThemeColors(patch.light) : "",
    patch.dark ? packThemeColors(patch.dark) : "",
  ].join(".");
}

export function decodeThemeBuilderPatch(value: string): ThemeBuilderPatch | undefined {
  const [version, corner, spacing, light, dark, ...extra] = value.split(".", 6);

  if (version !== "1" || dark === undefined || extra.length) return undefined;
  const patch: ThemeBuilderPatch = {};

  if (corner) {
    const choice = cornerRadiusNames.find((name) => name === corner);

    if (!choice) return undefined;
    patch.cornerRadius = choice;
  }

  if (spacing) {
    const choice = themeSpacingNames.find((name) => name === spacing);

    if (!choice) return undefined;
    patch.spacing = choice;
  }

  if (light) {
    const colors = unpackThemeColors(light);

    if (!colors) return undefined;
    patch.light = colors;
  }

  if (dark) {
    const colors = unpackThemeColors(dark);

    if (!colors) return undefined;
    patch.dark = colors;
  }

  return Object.keys(patch).length ? patch : undefined;
}
