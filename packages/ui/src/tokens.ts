import palette from "./palette.json";

export { palette };

export const accents = [
  { name: "default", label: "Default", palette: "blue" },
  { name: "grove", label: "Grove", palette: "emerald" },
  { name: "ocean", label: "Ocean", palette: "sky" },
  { name: "ember", label: "Ember", palette: "orange" },
  { name: "iris", label: "Iris", palette: "violet" },
  { name: "rose", label: "Rose", palette: "pink" },
] as const;

export type AccentName = (typeof accents)[number]["name"];

export const typography = {
  body: { fontSize: 16, lineHeight: 24 },
  small: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 16 },
  heading: { fontSize: 18, lineHeight: 28 },
  title: { fontSize: 24, lineHeight: 32 },
} as const;

/**
 * Phone values of the context scale (docs/ui-scale.md; web: scale.css). Overlays, chrome and work rows sit a
 * step under the content text; the composer's context row uses captions.
 */
export const contextType = {
  overlay: { fontSize: 15, lineHeight: 24 },
  overlaySmall: { fontSize: 13, lineHeight: 20 },
  chrome: { fontSize: 15, lineHeight: 20 },
  chromeSmall: { fontSize: 13, lineHeight: 18 },
  work: { fontSize: 15, lineHeight: 24 },
  workSmall: { fontSize: 13, lineHeight: 20 },
  context: { fontSize: 12, lineHeight: 16 },
} as const;

/**
 * Motion tokens shared with web (routes/layout.css `--duration-*`, `--distance-*`, `--scale-*`, `--ease-*`):
 * durations in ms, distances in px (dp on mobile), scales as factors and the curves as cubic-bezier points.
 */
export const motion = {
  stagger: 40,
  micro: 80,
  quick: 150,
  fast: 250,
  medium: 350,
  slow: 400,
  verySlow: 500,
  /** Indeterminate ring, matching the web spin cycle. */
  spin: 1000,
  /** Web shimmer: a 200% background, 40/50/60% stops, travelling two text widths per cycle. */
  shimmer: { duration: 2000, backgroundSize: 2, start: 0.4, peak: 0.5, end: 0.6, travel: 2 },
  distance: { micro: 4, small: 6, base: 8, medium: 12, large: 30 },
  scale: { large: 0.96, medium: 0.97, small: 0.98, tiny: 0.99 },
  smoothOut: [0.22, 1, 0.36, 1],
  inOut: [0.42, 0, 0.58, 1],
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  bubble: 20,
  full: 9999,
} as const;

export const space = (units: number) => units * 4;

export const statusTones = {
  creating: "sky",
  running: "sky",
  waiting_input: "amber",
  idle: "emerald",
  completed: "emerald",
  failed: "rose",
  interrupted: "orange",
  archived: "zinc",
  queued: "zinc",
  cancelled: "zinc",
  pending: "amber",
  allowed: "emerald",
  answered: "emerald",
  declined: "rose",
  expired: "zinc",
  online: "emerald",
  offline: "zinc",
} as const;
