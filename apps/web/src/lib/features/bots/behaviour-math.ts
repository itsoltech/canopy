import type { MascotShape, MascotShapeId } from "./mascot.ts";

export type MascotState = "idle" | "working" | "typing" | "waiting" | "done" | "error";
export interface EyeOffset { x: number; y: number }

/** Adapter for bots-core's existing human-readable status; explicit state props take precedence. */
export function stateForStatus(status: string): MascotState {
  if (!status.trim()) return "idle";
  if (/^typing/i.test(status)) return "typing";
  if (/^waiting/i.test(status)) return "waiting";
  if (/^(error|failed|could not)/i.test(status)) return "error";
  if (/^(done|completed)/i.test(status)) return "done";
  return "working";
}

/** Conservative face space in the shared 40×40 viewBox, including the full eye outline. */
const limits: Partial<Record<MascotShapeId, EyeOffset>> = {
  spark: { x: 0.6, y: 0.35 },
  star: { x: 0.6, y: 0.4 },
  diamond: { x: 0.9, y: 0.7 },
  triangle: { x: 0.75, y: 0.65 },
};

export function eyeLimits(shape: MascotShape, pupils = false): EyeOffset {
  // Legacy round eyes retain their original gaze; leave room inside their white sclera.
  if (pupils) return { x: 0.5, y: 0.5 };
  const id = "id" in shape ? shape.id as MascotShapeId : undefined;
  return (id && limits[id]) || { x: 1.2, y: 0.85 };
}

/** Elliptical clamp: diagonal glances cannot exceed the face's safe movement envelope. */
export function clampEyes(offset: EyeOffset, limit: EyeOffset): EyeOffset {
  const x = Number.isFinite(offset.x) ? offset.x : 0;
  const y = Number.isFinite(offset.y) ? offset.y : 0;
  const ratio = Math.max(1, Math.hypot(x / limit.x, y / limit.y));
  return { x: x / ratio, y: y / ratio };
}

export function eyeOffset(dx: number, dy: number, shape: MascotShape, pupils = false): EyeOffset {
  const limit = eyeLimits(shape, pupils);
  return clampEyes({ x: dx / 120 * limit.x, y: dy / 120 * limit.y }, limit);
}

export const idleBounds = { blink: [3600, 8200], glance: [12000, 24000] } as const;

/** Independent samples per mascot; injected randomness keeps the time bounds testable. */
export function idleDelay(kind: keyof typeof idleBounds, random = Math.random): number {
  const [min, max] = idleBounds[kind];
  return min + Math.min(1, Math.max(0, random())) * (max - min);
}

export function canAnimate({ alive = true, reduced = false, hidden = false, visible = true, size = 40 }: {
  alive?: boolean; reduced?: boolean; hidden?: boolean; visible?: boolean; size?: number;
}): boolean {
  return alive && !reduced && !hidden && visible && size >= 24;
}
