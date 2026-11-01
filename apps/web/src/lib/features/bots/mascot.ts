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

export function mascotFor(id: string): Mascot {
  const h = hash(id);
  return {
    shape: shapes[h % shapes.length]!,
    tone: tones[(h >>> 4) % tones.length]!,
    eyes: eyes[(h >>> 9) % eyes.length]!,
    gaze: (((h >>> 12) % 3) - 1) as -1 | 0 | 1,
    smile: ((h >>> 15) & 1) === 1,
  };
}

/** Colour of a participant's name (bots by id; you are not coloured). */
export const nameTone = (id: string): string => mascotFor(id).tone.name;
