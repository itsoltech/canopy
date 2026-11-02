import { computePosition } from "#lib/shared/ui/floating.ts";

type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "height">;

export interface CiteRoom {
  /** Viewport px: the top of the feed and the top of what covers its bottom (the sticky composer). */
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
}

/**
 * Where the Cite button goes (viewport px), or undefined when the selection's end is out of the room (scrolled
 * under the top bar or the composer). It sits at the selection's end — its start when made backwards — below the
 * line (with a mouse, flush to the end; on touch screens centred and clear of the selection handles), and flips
 * above the line when the room below it is too small, so it never covers the composer.
 */
export function citePosition(line: Box | undefined, size: { width: number; height: number }, room: CiteRoom, options: { backward: boolean; touch: boolean }): { x: number; y: number } | undefined {
  if (!line || line.bottom < room.top || line.top > room.bottom) return undefined;
  const x = options.backward ? line.left : line.right;
  const anchor = { left: x, right: x, width: 0, top: line.top - room.top, bottom: line.bottom - room.top, height: line.height };
  const position = computePosition(anchor, size, { width: room.width, height: room.bottom - room.top }, {
    placement: options.touch ? "bottom" : options.backward ? "top-start" : "bottom-end",
    offset: options.touch ? 28 : 6,
  });
  return { x: position.x, y: position.y + room.top };
}
