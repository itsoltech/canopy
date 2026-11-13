/** Enough rows from the end to fill the viewport before its first measurement. */
import type { SizeIndex } from "./size-index.ts";

export const INITIAL_HEIGHT = 2400;

/** Overscan when the rows first render: opening a thread renders about half of the rows in its frame. */
export const COLD_OVERSCAN = 240;

/** How much the overscan grows per idle period up to its full size (a row or two each time). */
export const OVERSCAN_STEP = 120;

/** Height of the rows mounted from the end before the viewport is measured (server, hydration). */
export const initialHeight = (): number =>
  "innerHeight" in globalThis ? Math.min(INITIAL_HEIGHT, innerHeight + 2 * COLD_OVERSCAN) : INITIAL_HEIGHT;

/** The window widened to keep a focused row mounted (not across a long jump away). */
export function keepMounted([start, end]: [number, number], focused: number | undefined): [number, number] {
  if (focused !== undefined && focused >= start - 100 && focused < end + 100)
    return [Math.min(start, focused), Math.max(end, focused + 1)];

  return [start, end];
}

/** Extra space lets a short last row reach the top when explicitly start-aligned. */
export function rowAlignmentSpace(
  index: SizeIndex,
  key: string | undefined,
  positions: ReadonlyMap<string, number>,
  viewport: number,
  footer: number,
): number {
  const at = key === undefined ? undefined : positions.get(key);

  return at === undefined ? 0 : Math.max(0, viewport - footer - (index.total - index.offset(at)));
}

/** Restore targets always mount even when their saved offset exceeds the current height estimate. */
export function feedRange(
  index: SizeIndex,
  positions: ReadonlyMap<string, number>,
  view: {
    viewport: number;
    scrollTop: number;
    listTop: number;
    anchor: { key: string; top: number } | undefined;
    stuck: boolean;
    overscan: number;
    focused: string | undefined;
    restoring: { key: string } | undefined;
  },
): [number, number] {
  const restoreAt = view.restoring && positions.get(view.restoring.key);

  if (restoreAt !== undefined)
    return [restoreAt, index.range(index.offset(restoreAt), index.offset(restoreAt) + initialHeight())[1]];

  if (view.viewport === 0) return index.tail(initialHeight());
  const at = view.anchor && positions.get(view.anchor.key);
  const top = at === undefined || !view.anchor ? view.scrollTop : view.listTop + index.offset(at) - view.anchor.top;
  const tail = view.stuck || top - view.listTop + view.viewport + view.overscan >= index.total;

  const bounds = tail
    ? index.tail(view.viewport + 2 * view.overscan)
    : index.range(top - view.listTop - view.overscan, top - view.listTop + view.viewport + view.overscan);

  return keepMounted(bounds, view.focused === undefined ? undefined : positions.get(view.focused));
}
