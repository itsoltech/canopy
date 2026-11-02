/**
 * Sizes of a panel the user resizes with a `ResizeHandle`: the range it may take and what a key does.
 * Arrows step by `step` (Shift: `bigStep`), Home / End jump to the ends, Enter resets.
 */
export interface ResizeRange {
  readonly min: number;
  readonly max: number;
  /** The size Enter and a double-click go back to. */
  readonly reset: number;
}

/** A finished change of a `ResizeHandle`: a drag let go, a key, a reset (Enter or a double-click). */
export interface ResizeChange {
  readonly size: number;
  /** Dragged past half the minimum of a `collapsible` panel (`size` is then the size it had before). */
  readonly collapsed: boolean;
  readonly reason: "drag" | "key" | "reset";
}

export const RESIZE_STEP = 16;
export const RESIZE_BIG_STEP = 64;

export const clampSize = (size: number, { min, max }: Pick<ResizeRange, "min" | "max">): number => Math.round(Math.max(min, Math.min(max, size)));

/**
 * The size after a key on the handle (`grows`: the arrow that makes the panel larger, "ArrowRight" for a
 * panel on the left); "reset" for Enter, undefined for keys the handle leaves alone.
 */
export function keySize(key: string, shift: boolean, size: number, range: ResizeRange, grows: "ArrowRight" | "ArrowLeft" = "ArrowRight"): number | "reset" | undefined {
  const step = shift ? RESIZE_BIG_STEP : RESIZE_STEP;
  const shrinks = grows === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
  switch (key) {
    case grows:
    case "ArrowUp":
      return clampSize(size + step, range);
    case shrinks:
    case "ArrowDown":
      return clampSize(size - step, range);
    case "Home":
      return range.min;
    case "End":
      return range.max;
    case "Enter":
      return "reset";
    default:
      return undefined;
  }
}
