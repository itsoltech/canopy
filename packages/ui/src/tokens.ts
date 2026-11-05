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

/** Motion tokens shared with web (motion.css): durations in ms and the smooth-out curve. */
export const motion = {
  micro: 80,
  quick: 150,
  fast: 250,
  medium: 350,
  smoothOut: [0.22, 1, 0.36, 1],
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
