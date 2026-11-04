/** Enough rows from the end to fill the viewport before its first measurement. */
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
