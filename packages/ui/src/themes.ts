import { palette } from "./tokens.ts";

export const themeNames = ["birch", "fern", "lagoon", "cedar", "heather", "blossom", "ash"] as const;

export type ThemeName = (typeof themeNames)[number];

export type ThemeMode = "light" | "dark";

export const neutralSteps = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950, 1000] as const;

type NeutralScale = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

interface ColorTheme {
  label: string;
  description: string;
  accent: "blue" | "emerald" | "sky" | "orange" | "violet" | "pink" | "neutral";
  light: NeutralScale;
  dark: NeutralScale;
}

/** Ordered from paper to ink. Each mode has its own tint and surface separation. */
export const themes: Record<ThemeName, ColorTheme> = {
  birch: {
    label: "Birch",
    description: "Soft chalk · blue ink",
    accent: "blue",
    light: [
      "#fffefa",
      "#f7f6f2",
      "#eeede7",
      "#dcdbd3",
      "#c1c0b7",
      "#918f85",
      "#68665c",
      "#5b594f",
      "#47453d",
      "#32312b",
      "#23231f",
      "#191915",
      "#12120f",
    ],
    dark: [
      "#f7f5ed",
      "#efede5",
      "#e5e3da",
      "#ceccc2",
      "#b4b2a7",
      "#a6a498",
      "#838174",
      "#68665a",
      "#4c4b41",
      "#37372f",
      "#292a24",
      "#20211c",
      "#171914",
    ],
  },
  fern: {
    label: "Fern",
    description: "Leaf green · forest shade",
    accent: "emerald",
    light: [
      "#fbfef9",
      "#f0f6ed",
      "#e3edde",
      "#ccdcc5",
      "#afc5a6",
      "#7f9778",
      "#566d4f",
      "#4b6245",
      "#394d35",
      "#293a27",
      "#1c2a1b",
      "#142013",
      "#0d170d",
    ],
    dark: [
      "#eff8e9",
      "#e5f0df",
      "#d7e7cf",
      "#bed4b5",
      "#a7c09d",
      "#93ad88",
      "#758c6b",
      "#58704f",
      "#3e5238",
      "#2b3d27",
      "#20311e",
      "#192818",
      "#112010",
    ],
  },
  lagoon: {
    label: "Lagoon",
    description: "Sea glass · deep teal",
    accent: "sky",
    light: [
      "#f9feff",
      "#edf6f8",
      "#deedf1",
      "#c4dce3",
      "#a3c2cc",
      "#7598a4",
      "#4b6b76",
      "#405f6a",
      "#304b55",
      "#233841",
      "#182931",
      "#101e25",
      "#0a151c",
    ],
    dark: [
      "#eaf8fb",
      "#dfedf2",
      "#cfe2e9",
      "#b5cfd9",
      "#9cbcc9",
      "#8eafbe",
      "#658a9a",
      "#4b6c7c",
      "#344f5e",
      "#253c49",
      "#1b2e39",
      "#142530",
      "#0d1c26",
    ],
  },
  cedar: {
    label: "Cedar",
    description: "Warm sand · redwood",
    accent: "orange",
    light: [
      "#fffcf7",
      "#faf1e6",
      "#f2e4d3",
      "#e3cdb5",
      "#ccad8f",
      "#a08568",
      "#7b624a",
      "#654d39",
      "#503b2a",
      "#3c2a1e",
      "#2c1e16",
      "#20160f",
      "#170f0a",
    ],
    dark: [
      "#fff0df",
      "#f4e4d1",
      "#e8d4bd",
      "#d4bda3",
      "#c1a68b",
      "#b69d82",
      "#90765d",
      "#725a44",
      "#554130",
      "#402f23",
      "#32241b",
      "#291c15",
      "#20150f",
    ],
  },
  heather: {
    label: "Heather",
    description: "Lilac mist · dusk violet",
    accent: "violet",
    light: [
      "#fefbff",
      "#f6f0fa",
      "#ece2f2",
      "#dacbe3",
      "#bfaacb",
      "#95809f",
      "#6d5a76",
      "#604d69",
      "#4b3b54",
      "#382b40",
      "#291f30",
      "#1d1623",
      "#140e19",
    ],
    dark: [
      "#f7edff",
      "#ece0f5",
      "#decfe9",
      "#c8b6d5",
      "#b39cc3",
      "#ad95be",
      "#866d98",
      "#695375",
      "#4e3c59",
      "#3b2c45",
      "#2d2137",
      "#241a2d",
      "#1b1223",
    ],
  },
  blossom: {
    label: "Blossom",
    description: "Petal pink · mulberry",
    accent: "pink",
    light: [
      "#fffbfd",
      "#fcf0f5",
      "#f5e0e9",
      "#e9c7d6",
      "#d3a7bb",
      "#aa7e93",
      "#7d5469",
      "#6c475d",
      "#56364a",
      "#402738",
      "#2e1b29",
      "#22131e",
      "#180b14",
    ],
    dark: [
      "#ffedf5",
      "#f6dfe9",
      "#eacddc",
      "#d7b1c5",
      "#c39bb0",
      "#bd93ab",
      "#946b83",
      "#755168",
      "#593b50",
      "#442b3e",
      "#352031",
      "#2c1928",
      "#23121f",
    ],
  },
  ash: {
    label: "Ash",
    description: "Pure white · true black",
    accent: "neutral",
    light: [
      "#ffffff",
      "#ffffff",
      "#f5f5f5",
      "#d9d9d9",
      "#bfbfbf",
      "#8c8c8c",
      "#666666",
      "#525252",
      "#404040",
      "#262626",
      "#171717",
      "#111111",
      "#000000",
    ],
    dark: [
      "#ffffff",
      "#f5f5f5",
      "#e5e5e5",
      "#d4d4d4",
      "#bfbfbf",
      "#a3a3a3",
      "#808080",
      "#666666",
      "#383838",
      "#171717",
      "#000000",
      "#000000",
      "#000000",
    ],
  },
};

const neutralAccent = {
  50: "#fafafa",
  100: "#f5f5f5",
  200: "#e5e5e5",
  300: "#d4d4d4",
  400: "#b3b3b3",
  500: "#808080",
  600: "#707070",
  700: "#606060",
  800: "#4d4d4d",
  900: "#262626",
  950: "#171717",
};

export const isThemeName = (name: string | undefined): name is ThemeName => themeNames.some((value) => value === name);

/** CSS values are trusted literals; callers never interpolate persisted free-form CSS. */
export function themeVariables(name: ThemeName, mode: ThemeMode) {
  const theme = themes[name];
  const neutral = theme[mode];
  const colors = Object.fromEntries(neutralSteps.map((step, index) => [`zinc-${step}`, neutral[index]!]));
  const accent = theme.accent === "neutral" ? neutralAccent : palette[theme.accent];
  const dark = mode === "dark";
  const tint = dark ? neutral[10] : neutral[2];

  return {
    ...colors,
    ...Object.fromEntries(Object.entries(accent).map(([step, color]) => [`brand-${step}`, color])),
    canvas: dark ? neutral[12] : neutral[0],
    surface: dark ? neutral[11] : neutral[0],
    panel: dark ? neutral[10] : neutral[1],
    hover: dark ? neutral[9] : neutral[2],
    ink: dark ? neutral[0] : neutral[11],
    muted: dark ? neutral[4] : neutral[6],
    border: dark ? neutral[8] : neutral[3],
    accent: accent[dark ? 400 : 700],
    action: accent[700],
    "action-hover": accent[800],
    "on-accent": "#ffffff",
    ...Object.fromEntries(
      (["emerald", "amber", "rose", "sky", "orange", "violet"] as const).flatMap((tone) =>
        Object.entries(palette[tone]).map(([step, color]) => [
          `${tone}-${step}`,
          `color-mix(in oklab, ${dark && step === "400" ? palette[tone][300] : !dark && (step === "600" || step === "700") ? palette[tone][800] : color} 94%, ${tint})`,
        ]),
      ),
    ),
  };
}

export function paletteStyle(light: ThemeName, dark: ThemeName): string {
  const variants = (["light", "dark"] as const).flatMap((mode) =>
    Object.entries(themeVariables(mode === "light" ? light : dark, mode)).map(
      ([key, value]) => `--${mode}-${key}:${value}`,
    ),
  );

  const aliases = Object.keys(themeVariables(light, "light")).map(
    (key) => `--theme-${key}:light-dark(var(--light-${key}),var(--dark-${key}))`,
  );

  const brand = Object.keys(palette.blue).map((step) => `--brand-${step}:var(--theme-brand-${step})`);

  return [...variants, ...aliases, ...brand].join(";");
}
