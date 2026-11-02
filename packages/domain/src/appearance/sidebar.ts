/**
 * Width of the desktop sidebar (Appearance `sidebar_width`, px; 0 = the default). The gateway keeps a saved
 * width within `min`…`max`; the UI also keeps it under `viewportShare` of the window, so a width saved on a
 * wide screen shrinks on a narrow one (and comes back on the wide one).
 */
export const SIDEBAR_WIDTH = {
  /** The current fixed sidebar (Tailwind w-72). */
  default: 288,
  /** Narrowest width where the section switch, search and thread rows (title + time) still fit. */
  min: 220,
  max: 560,
  /** Share of the window the sidebar may take at most. */
  viewportShare: 0.45,
} as const;

/** What the gateway stores: 0 stays "default", anything else is held within min…max (whole px). */
export function storedSidebarWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

/** Widest the sidebar may be in a window `viewport` px wide (never under `min`). */
export function maxSidebarWidth(viewport: number): number {
  return Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.floor(viewport * SIDEBAR_WIDTH.viewportShare)));
}

/** The width shown for a saved value (0 = default) in a window `viewport` px wide. */
export function sidebarWidthFor(saved: number, viewport: number): number {
  const width = saved > 0 ? saved : SIDEBAR_WIDTH.default;
  return Math.round(Math.min(maxSidebarWidth(viewport), Math.max(SIDEBAR_WIDTH.min, width)));
}
