/**
 * Anchored positioning for popovers, menus, tooltips and hover cards (no dependency): place a floating
 * element next to its anchor, flip to the other side when it does not fit, shift it along the edge to
 * stay in the viewport. Results go into CSS variables, so the element's classes decide what to use:
 * `--float-x`, `--float-y` (viewport px), `--float-available-height` (room on the chosen side),
 * `--float-anchor-width` and `--float-origin` (the anchor's side, for motion that grows from it).
 *
 *   const stop = autoPosition(anchor, panel, { placement: "top-start" });
 *   // panel: class="fixed left-(--float-x) top-(--float-y) max-h-(--float-available-height)"
 */

export type Side = "top" | "bottom" | "left" | "right";

export type Placement = Side | `${Side}-start` | `${Side}-end`;

export interface PositionOptions {
  readonly placement?: Placement;
  /** Gap between anchor and element, px. */
  readonly offset?: number;
  /** Minimum distance from the viewport edge, px. */
  readonly padding?: number;
  /** Follow transforms that move the anchor without resizing it (for example the composer). */
  readonly followMotion?: boolean;
}

export interface Position {
  readonly x: number;
  readonly y: number;
  /** Side actually used (after flipping). */
  readonly side: Side;
  readonly availableHeight: number;
}

const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

type Align = "start" | "center" | "end";

/** Every placement, as its side and its alignment along that side. */
const PLACEMENTS = new Map<Placement, readonly [Side, Align]>(
  (["top", "bottom", "left", "right"] as const).flatMap((side) => [
    [side, [side, "center"]],
    [`${side}-start`, [side, "start"]],
    [`${side}-end`, [side, "end"]],
  ]),
);

function split(placement: Placement): readonly [Side, Align] {
  return PLACEMENTS.get(placement) ?? ["bottom", "start"];
}

/** Pure placement maths: anchor rectangle, floating size and viewport size in, coordinates out. */
export function computePosition(
  anchor: Pick<DOMRect, "top" | "bottom" | "left" | "right" | "width" | "height">,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number; readonly top?: number },
  { placement = "bottom-start", offset = 6, padding = 8 }: PositionOptions = {},
): Position {
  const [preferred, align] = split(placement);
  const safeTop = viewport.top ?? 0;
  const top = safeTop + padding;

  const room: Record<Side, number> = {
    top: anchor.top - offset - top,
    bottom: viewport.height - (safeTop > 0 ? Math.max(anchor.bottom + offset, top) : anchor.bottom + offset) - padding,
    left: anchor.left - offset - padding,
    right: viewport.width - anchor.right - offset - padding,
  };

  const vertical = preferred === "top" || preferred === "bottom";
  const needed = vertical ? size.height : size.width;

  // Flip when the preferred side is too small and the other side has more room.
  const side =
    room[preferred] < needed && room[opposite[preferred]] > room[preferred] ? opposite[preferred] : preferred;

  let x: number;
  let y: number;

  if (vertical) {
    y = side === "bottom" ? anchor.bottom + offset : anchor.top - offset - Math.min(size.height, room.top);

    // Keep zero-safe-area placement identical, including anchors scrolled beyond the viewport.
    if (safeTop > 0) y = Math.max(top, y);
    x = aligned(align, anchor.left, anchor.right - size.width, anchor.left + (anchor.width - size.width) / 2);
    x = clamp(x, padding, viewport.width - size.width - padding);
  } else {
    x = side === "right" ? anchor.right + offset : anchor.left - offset - size.width;
    y = aligned(align, anchor.top, anchor.bottom - size.height, anchor.top + (anchor.height - size.height) / 2);
    y = clamp(y, top, viewport.height - size.height - padding);
  }

  const availableHeight = vertical ? Math.max(room[side], 0) : viewport.height - top - padding;

  return { x: Math.round(x), y: Math.round(y), side, availableHeight: Math.floor(availableHeight) };
}

/** The coordinate for an alignment: the anchor's start edge, its end edge or its center. */
function aligned(align: Align, start: number, end: number, center: number): number {
  switch (align) {
    case "start":
      return start;
    case "end":
      return end;
    default:
      return center;
  }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/** Position `floating` once (it must be rendered, e.g. an open popover). */
export function positionNow(anchor: Element, floating: HTMLElement, options?: PositionOptions): Position {
  const position = computePosition(
    anchor.getBoundingClientRect(),
    { width: floating.offsetWidth, height: floating.offsetHeight },
    {
      width: document.documentElement.clientWidth,
      height: window.innerHeight,
      top: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-safe-top")) || 0,
    },
    options,
  );

  floating.style.setProperty("--float-x", `${position.x}px`);
  floating.style.setProperty("--float-y", `${position.y}px`);
  floating.style.setProperty("--float-available-height", `${position.availableHeight}px`);
  const box = anchor.getBoundingClientRect();
  floating.style.setProperty("--float-anchor-width", `${box.width}px`);
  floating.style.setProperty("--float-origin", transformOrigin(position, box, floating));
  floating.dataset.side = position.side;

  return position;
}

/** Where the floating element grows from: the edge facing the anchor, at the anchor's centre. */
function transformOrigin(position: Position, anchor: DOMRect, floating: HTMLElement): string {
  const across = (from: number, size: number, center: number) => `${Math.round(clamp(center - from, 0, size))}px`;

  if (position.side === "top" || position.side === "bottom") {
    return `${across(position.x, floating.offsetWidth, anchor.left + anchor.width / 2)} ${position.side === "bottom" ? "top" : "bottom"}`;
  }

  return `${position.side === "right" ? "left" : "right"} ${across(position.y, floating.offsetHeight, anchor.top + anchor.height / 2)}`;
}

/**
 * Keep `floating` attached to `anchor` while either moves or resizes (scroll in any container, window
 * resize, content changes). Returns the cleanup.
 */
export function autoPosition(anchor: Element, floating: HTMLElement, options?: PositionOptions): () => void {
  let frame = 0;
  let motionFrame = 0;
  let previous = anchor.getBoundingClientRect();

  const follow = () => {
    const rect = anchor.getBoundingClientRect();

    if (
      rect.x !== previous.x ||
      rect.y !== previous.y ||
      rect.width !== previous.width ||
      rect.height !== previous.height
    )
      positionNow(anchor, floating, options);
    previous = rect;
    motionFrame = requestAnimationFrame(follow);
  };

  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => positionNow(anchor, floating, options));
  };

  positionNow(anchor, floating, options);

  if (options?.followMotion) motionFrame = requestAnimationFrame(follow);

  const observer = new ResizeObserver(update);
  observer.observe(anchor);
  observer.observe(floating);
  // Fullscreen/bridge zoom can change the safe area while a menu stays open.
  const windowState = new MutationObserver(update);
  windowState.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "data-window-fullscreen", "data-canopy-platform"],
  });
  window.addEventListener("scroll", update, { capture: true, passive: true });
  window.addEventListener("resize", update, { passive: true });

  return () => {
    cancelAnimationFrame(frame);
    cancelAnimationFrame(motionFrame);
    observer.disconnect();
    windowState.disconnect();
    window.removeEventListener("scroll", update, { capture: true });
    window.removeEventListener("resize", update);
  };
}

/** Elements that can take focus inside `root`, in DOM order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
}
