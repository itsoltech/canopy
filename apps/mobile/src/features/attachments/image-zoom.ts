export type Size = { width: number; height: number };

export type Point = { x: number; y: number };

export const MAX_SCALE = 6;
export const DOUBLE_TAP_SCALE = 2.5;

/** Pinching below the fitted size stretches a little, then settles back. */
export const MIN_PINCH = 0.7;

export function clamp(value: number, limit: number) {
  "worklet";

  return Math.min(limit, Math.max(-limit, value));
}

/** Contain leaves letterboxing. Bound the actual fitted image, including after orientation changes. */
export function panLimits(viewport: Size, image: Size | undefined, scale: number): Point {
  "worklet";

  if (!viewport.width || !viewport.height) return { x: 0, y: 0 };
  const width = image?.width || viewport.width;
  const height = image?.height || viewport.height;
  const fit = Math.min(viewport.width / width, viewport.height / height);

  return {
    x: Math.max(0, (width * fit * scale - viewport.width) / 2),
    y: Math.max(0, (height * fit * scale - viewport.height) / 2),
  };
}

/**
 * Translation that keeps the content point under `from` (offset from the centre, at `scale` and `offset`) under
 * `to` at `next` scale: pinching zooms around the fingers and moving them pans.
 */
export function zoomAround(from: Point, to: Point, offset: Point, scale: number, next: number): Point {
  "worklet";

  return {
    x: to.x - (next * (from.x - offset.x)) / scale,
    y: to.y - (next * (from.y - offset.y)) / scale,
  };
}

/** Past an end of the strip the drag follows the finger at a fraction of its travel. */
export function resist(distance: number) {
  "worklet";

  return distance * 0.3;
}
