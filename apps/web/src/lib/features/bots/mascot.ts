/**
 * Generated bot mascots: a body shape, a colour and a pair of eyes, all derived from the bot id, so
 * a bot looks the same everywhere and on every device without storing anything. Drawn in a 40×40
 * box (see `BotAvatar`).
 */

export interface MascotShape {
  body: string;
  /** Vertical centre of the eyes for this body. */
  eyeY: number;
}

const shapes: readonly MascotShape[] = [
  // Round blob.
  { body: "M20 7c8 0 13 5.5 13 13.5S28.5 34 20 34 7 28.5 7 20.5 12 7 20 7Z", eyeY: 20 },
  // Squircle.
  { body: "M9 18c0-7 4-10 11-10s11 3 11 10v6c0 7-4 10-11 10S9 31 9 24Z", eyeY: 20 },
  // Ghost.
  { body: "M8 20a12 12 0 0 1 24 0v13l-3-2-3 2-3-2-3 2-3-2-3 2-3-2-3 2Z", eyeY: 19 },
  // Cloud.
  { body: "M14 13a6 6 0 0 1 12 0 6 6 0 0 1 6 9 6 6 0 0 1-4 10H12a6 6 0 0 1-4-10 6 6 0 0 1 6-9Z", eyeY: 21 },
  // Drop.
  { body: "M20 6c6 7 12 12 12 18a12 12 0 0 1-24 0c0-6 6-11 12-18Z", eyeY: 24 },
  // Capsule.
  { body: "M6 22a9 9 0 0 1 9-9h10a9 9 0 0 1 0 18H15a9 9 0 0 1-9-9Z", eyeY: 21 },
  // Soft triangle.
  { body: "M20 7c2 0 3 1 4 3l9 17c1.5 3-.5 6-4 6H11c-3.5 0-5.5-3-4-6l9-17c1-2 2-3 4-3Z", eyeY: 24 },
];

/** Explicit appearance choices. Keep the legacy hashed array above stable for existing avatars. */
export const mascotShapes = [
  { id: "round", label: "Round", ...shapes[0]! },
  { id: "cloud", label: "Cloud", ...shapes[3]! },
  { id: "diamond", label: "Diamond", body: "M18 5q2-2 4 0l13 13q2 2 0 4L22 35q-2 2-4 0L5 22q-2-2 0-4Z", eyeY: 20 },
  { id: "spark", label: "Four-point star", body: "M20 3q3 12 5 12l12 5-12 5q-2 0-5 12-3-12-5-12L3 20l12-5q2 0 5-12Z", eyeY: 20 },
  { id: "clover", label: "Clover", body: "M20 10C9-1 0 12 10 20 0 29 11 41 20 30c9 11 20-1 10-10C40 11 30-1 20 10Z", eyeY: 20 },
  { id: "blob", label: "Blob", body: "M19 5c7-3 9 5 13 9 7 7 3 13-3 15-4 2-5 8-12 6C7 34 3 28 6 21 8 16 11 8 19 5Z", eyeY: 22 },
  { id: "flower", label: "Flower", body: "M15 10c-1-10 11-10 10 0 8-6 16 4 7 9 10 3 4 15-4 10 1 10-13 12-14 2-8 7-17-4-8-10-9-5 1-15 9-11Z", eyeY: 21 },
  { id: "droplet", label: "Droplet", ...shapes[4]! },
  { id: "pill", label: "Pill", ...shapes[5]! },
  { id: "triangle", label: "Triangle", ...shapes[6]! },
  { id: "square", label: "Rounded square", body: "M12 6h16q6 0 6 6v16q0 6-6 6H12q-6 0-6-6V12q0-6 6-6Z", eyeY: 20 },
  { id: "star", label: "Spiky star", body: "m20 3 4 8 8-4-1 9 7 4-8 4 3 9-9-3-4 8-4-8-9 3 3-9-8-4 7-4-1-9 8 4Z", eyeY: 20 },
  { id: "hexagon", label: "Hexagon", body: "M15 5h10q2 0 3 2l8 11q1 2 0 4L28 33q-1 2-3 2H15q-2 0-3-2L4 22q-1-2 0-4L12 7q1-2 3-2Z", eyeY: 20 },
  { id: "pumpkin", label: "Pumpkin", body: "M18 10V5q0-2 3-2h3v4h-3v3c14-6 20 20 6 24q-4 2-7 0-3 2-7 0C-1 30 4 4 18 10Z", eyeY: 22 },
] as const satisfies readonly (MascotShape & { id: string; label: string })[];

export type MascotShapeId = (typeof mascotShapes)[number]["id"];

export interface BotAppearance {
  shape: MascotShapeId;
  /** An opaque sRGB colour, normalized to #rrggbb. */
  color: string;
}

export const mascotColors = [
  { label: "Black", value: "#27272a" },
  { label: "Brown", value: "#926344" },
  { label: "Red", value: "#ef4444" },
  { label: "Orange", value: "#f97316" },
  { label: "Amber", value: "#fbbf24" },
  { label: "Green", value: "#65a30d" },
  { label: "Teal", value: "#14b8a6" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Violet", value: "#8b5cf6" },
  { label: "Pink", value: "#ec4899" },
  { label: "Grey", value: "#a1a1aa" },
] as const;

export const defaultAppearance: BotAppearance = { shape: "round", color: "#f97316" };

/** Accept CSS hex shorthand, but never arbitrary CSS or transparent colours. */
export function normalizeColor(value: string): string | undefined {
  const hex = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex)) return `#${[...hex].map((c) => c + c).join("").toLowerCase()}`;
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : undefined;
}

/** WCAG sRGB relative luminance. Choose whichever eye colour has the higher contrast. */
export function eyeColor(color: string): "#ffffff" | "#18181b" {
  const hex = normalizeColor(color) ?? defaultAppearance.color;
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / (0.00925 + 0.05) ? "#ffffff" : "#18181b";
}

/** Colour of a bot: its avatar (background + body) and its name in group chats. */
export interface MascotTone {
  background: string;
  body: string;
  name: string;
}

const tones: readonly MascotTone[] = [
  { background: "bg-orange-500/15", body: "fill-orange-400", name: "text-orange-700 dark:text-orange-400" },
  { background: "bg-amber-500/15", body: "fill-amber-300", name: "text-amber-700 dark:text-amber-300" },
  { background: "bg-lime-500/15", body: "fill-lime-400", name: "text-lime-700 dark:text-lime-400" },
  { background: "bg-emerald-500/15", body: "fill-emerald-400", name: "text-emerald-700 dark:text-emerald-400" },
  { background: "bg-teal-500/15", body: "fill-teal-300", name: "text-teal-700 dark:text-teal-300" },
  { background: "bg-sky-500/15", body: "fill-sky-400", name: "text-sky-700 dark:text-sky-400" },
  { background: "bg-blue-500/15", body: "fill-blue-400", name: "text-blue-700 dark:text-blue-400" },
  { background: "bg-violet-500/15", body: "fill-violet-400", name: "text-violet-700 dark:text-violet-400" },
  { background: "bg-fuchsia-500/15", body: "fill-fuchsia-400", name: "text-fuchsia-700 dark:text-fuchsia-400" },
  { background: "bg-rose-500/15", body: "fill-rose-400", name: "text-rose-700 dark:text-rose-400" },
];

export type MascotEyes = "round" | "dots" | "happy";
const eyes: readonly MascotEyes[] = ["round", "dots", "happy"];

export interface Mascot {
  shape: MascotShape;
  tone: MascotTone;
  eyes: MascotEyes;
  /** Where the pupils look, -1 (left) … 1 (right). */
  gaze: number;
  smile: boolean;
}

/** FNV-1a, 32 bit: stable across sessions and runtimes. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function mascotFor(id: string, shape?: string): Mascot {
  const h = hash(id);
  return {
    shape: shapes[["round", "squircle", "ghost", "cloud", "drop", "capsule", "triangle"].indexOf(shape ?? "")] ?? shapes[h % shapes.length]!,
    tone: tones[(h >>> 4) % tones.length]!,
    eyes: eyes[(h >>> 9) % eyes.length]!,
    gaze: (((h >>> 12) % 3) - 1) as -1 | 0 | 1,
    smile: ((h >>> 15) & 1) === 1,
  };
}

/** Colour of a participant's name (bots by id; you are not coloured). */
export const nameTone = (id: string): string => mascotFor(id).tone.name;
