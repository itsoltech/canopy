export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayArea {
  id: number;
  workArea: Rect;
}

export interface SizeLimits {
  minWidth: number;
  minHeight: number;
}

function overlap(a: Rect, b: Rect) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

  return width > 0 && height > 0 ? width * height : 0;
}

function contains(outer: Rect, inner: Rect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function centreDistance(a: Rect, b: Rect) {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

/** The saved display when it still exists, else the one showing most of the window, else the closest one. */
function targetDisplay(bounds: Rect, displayId: number | undefined, displays: readonly DisplayArea[]) {
  const saved = displays.find((display) => display.id === displayId);

  if (saved) return saved;

  const [first, ...rest] = displays;

  if (!first) return undefined;

  return rest.reduce((best, display) => {
    const shown = overlap(bounds, display.workArea) - overlap(bounds, best.workArea);

    if (shown !== 0) return shown > 0 ? display : best;

    return centreDistance(bounds, display.workArea) < centreDistance(bounds, best.workArea) ? display : best;
  }, first);
}

/** Keeps the leading edge (and the title bar) visible when the window is larger than the area. */
function fit(start: number, size: number, areaStart: number, areaSize: number) {
  return Math.round(Math.max(areaStart, Math.min(start, areaStart + areaSize - size)));
}

/**
 * Bounds to open a window at, or undefined to let the system centre it at the default size.
 * Bounds fully inside a display's work area are kept. Anything else (removed monitor, smaller
 * resolution, window dragged partly off-screen) moves onto one display and fits its work area,
 * never below the window's minimum size. A window with no visible part is centred there.
 */
export function restoredBounds(
  saved: Rect,
  displayId: number | undefined,
  displays: readonly DisplayArea[],
  limits: SizeLimits,
): Rect | undefined {
  const bounds = {
    ...saved,
    width: Math.max(limits.minWidth, saved.width),
    height: Math.max(limits.minHeight, saved.height),
  };

  if (displays.some((display) => contains(display.workArea, bounds))) return bounds;

  const display = targetDisplay(bounds, displayId, displays);

  if (!display) return undefined;

  const area = display.workArea;
  const width = Math.round(Math.max(limits.minWidth, Math.min(bounds.width, area.width)));
  const height = Math.round(Math.max(limits.minHeight, Math.min(bounds.height, area.height)));

  const centred = overlap(bounds, area) === 0;
  const x = centred ? area.x + (area.width - width) / 2 : bounds.x;
  const y = centred ? area.y + (area.height - height) / 2 : bounds.y;

  return { x: fit(x, width, area.x, area.width), y: fit(y, height, area.y, area.height), width, height };
}
