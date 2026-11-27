import type { Rectangle } from "electron";
import type { ActivityNotchEdge, ActivityNotchPlacement } from "@canopy/ui/desktop";
import {
  activityNotchEarWidth as ear,
  activityNotchExpandedWidth,
  activityNotchFloatingMargin as margin,
  activityNotchGripWidth,
  activityNotchRowsHeight,
  activityNotchSimulatedHeight as thickness,
  activityNotchTabLength as length,
  activityNotchVisibleRows,
  type ActivityNotchRect,
  type ActivityNotchSide,
} from "./activity-notch-geometry.ts";

export type DockedPlacement = Exclude<ActivityNotchPlacement, { mode: "notch" }>;

/** Everything in screen coordinates; activity-notch-window.ts makes it relative to the native window. */
export interface ActivityNotchFrame {
  window: Rectangle;
  side: ActivityNotchSide;
  header: "start" | "end";
  shape: ActivityNotchRect;
  tab: ActivityNotchRect;
  list: ActivityNotchRect;
  headerHeight: number;
}

const pillWidth = activityNotchGripWidth + length;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const bottomOf = (rect: Rectangle) => rect.y + rect.height;
const rightOf = (rect: Rectangle) => rect.x + rect.width;

/**
 * The window grows only to the right and downward from a corner that does not depend on the rows, so opening or
 * closing never moves its origin. A moved origin would show the outline out of place until the renderer catches up.
 * An outline that opens upward keeps a window tall enough for every row instead. While dragging, the window is
 * just the tab, so the tab keeps its place inside it as it follows the pointer.
 */
export function activityNotchFrame(
  area: Rectangle,
  placement: DockedPlacement,
  rows: number,
  reservedRows: number,
  dragging = false,
): ActivityNotchFrame {
  if (placement.mode === "floating") return floatingFrame(area, placement, rows, reservedRows, dragging);

  if (placement.edge === "left" || placement.edge === "right")
    return sideFrame(area, placement.edge, placement.offset, rows, reservedRows, dragging);

  return horizontalFrame(area, placement.edge === "top", placement.offset, rows, reservedRows, dragging);
}

/** The list is capped by the room the area leaves; past five rows it scrolls. */
function rowsHeight(rows: number, room: number) {
  return Math.max(0, Math.min(activityNotchRowsHeight(rows), room));
}

function horizontalFrame(
  area: Rectangle,
  top: boolean,
  offset: number,
  rows: number,
  reservedRows: number,
  dragging: boolean,
): ActivityNotchFrame {
  const room = area.height - thickness;
  const width = Math.min(activityNotchExpandedWidth, area.width - 2 * ear);
  const center = clamp(area.x + offset * area.width, area.x + ear + length / 2, rightOf(area) - ear - length / 2);

  const tab = {
    x: Math.round(center - length / 2),
    y: top ? area.y : bottomOf(area) - thickness,
    width: length,
    height: thickness,
  };

  const x = clamp(Math.round(center - width / 2), area.x + ear, rightOf(area) - ear - width);

  const open = (count: number) => {
    const height = thickness + rowsHeight(count, room);

    return { x, y: top ? area.y : bottomOf(area) - height, width, height };
  };

  const listRows = rowsHeight(Math.max(rows, 1), room);
  const list = { x, y: top ? area.y + thickness : bottomOf(area) - thickness - listRows, width, height: listRows };
  const tallest = open(activityNotchVisibleRows);

  const window = dragging
    ? { x: tab.x - ear, y: tab.y, width: length + 2 * ear, height: thickness }
    : top
      ? { x: x - ear, y: area.y, width: width + 2 * ear, height: open(reservedRows).height }
      : { x: x - ear, y: tallest.y, width: width + 2 * ear, height: tallest.height };

  return {
    window,
    side: top ? "top" : "bottom",
    header: top ? "start" : "end",
    shape: rows ? open(rows) : tab,
    tab,
    list,
    headerHeight: thickness,
  };
}

function sideFrame(
  area: Rectangle,
  edge: Extract<ActivityNotchEdge, "left" | "right">,
  offset: number,
  rows: number,
  reservedRows: number,
  dragging: boolean,
): ActivityNotchFrame {
  const room = area.height - 2 * ear - thickness;
  const width = Math.min(activityNotchExpandedWidth, area.width);
  const x = edge === "right" ? rightOf(area) - width : area.x;
  const center = clamp(area.y + offset * area.height, area.y + ear + length / 2, bottomOf(area) - ear - length / 2);

  const tab = {
    x: edge === "right" ? rightOf(area) - thickness : area.x,
    y: Math.round(center - length / 2),
    width: thickness,
    height: length,
  };

  // The panel drops from the tab's top and only rises as far as it must to stay on the screen.
  const top = (height: number) => Math.max(area.y + ear, Math.min(tab.y, bottomOf(area) - ear - height));

  const open = (count: number) => {
    const height = thickness + rowsHeight(count, room);

    return { x, y: top(height), width, height };
  };

  const origin = top(thickness + rowsHeight(activityNotchVisibleRows, room)) - ear;
  const bottom = Math.max(bottomOf(tab), reservedRows ? bottomOf(open(reservedRows)) : 0) + ear;
  const opened = open(Math.max(rows, 1));

  return {
    window: dragging
      ? { x: tab.x, y: tab.y - ear, width: thickness, height: length + 2 * ear }
      : { x, y: origin, width, height: bottom - origin },
    side: edge,
    header: "start",
    shape: rows ? open(rows) : tab,
    tab,
    list: { x, y: opened.y + thickness, width, height: opened.height - thickness },
    headerHeight: thickness,
  };
}

function floatingFrame(
  area: Rectangle,
  placement: Extract<DockedPlacement, { mode: "floating" }>,
  rows: number,
  reservedRows: number,
  dragging: boolean,
): ActivityNotchFrame {
  const tab = {
    x: Math.round(area.x + placement.x * Math.max(0, area.width - pillWidth)),
    y: Math.round(area.y + placement.y * Math.max(0, area.height - thickness)),
    width: pillWidth,
    height: thickness,
  };

  const width = Math.min(activityNotchExpandedWidth, area.width);
  const x = clamp(Math.round(tab.x + pillWidth / 2 - width / 2), area.x, rightOf(area) - width);
  // It opens downward when every row fits below the pill, and upward otherwise.
  const down = tab.y + thickness + activityNotchRowsHeight(activityNotchVisibleRows) <= bottomOf(area);
  const room = down ? bottomOf(area) - bottomOf(tab) : tab.y - area.y;

  const open = (count: number) => {
    const height = thickness + rowsHeight(count, room);

    return { x, y: down ? tab.y : bottomOf(tab) - height, width, height };
  };

  const opened = open(Math.max(rows, 1));
  const tallest = open(activityNotchVisibleRows);

  const window = dragging
    ? { x: tab.x - margin, y: tab.y - margin, width: pillWidth + 2 * margin, height: thickness + 2 * margin }
    : {
        x: x - margin,
        y: (down ? tab.y : tallest.y) - margin,
        width: width + 2 * margin,
        height: (down ? open(reservedRows).height : tallest.height) + 2 * margin,
      };

  return {
    window,
    side: "float",
    header: down ? "start" : "end",
    shape: rows ? open(rows) : tab,
    tab,
    list: { x, y: down ? opened.y + thickness : opened.y, width, height: opened.height - thickness },
    headerHeight: thickness,
  };
}

/** Within this distance of a centered place, a dragged tab or pill settles on the center. */
export const activityNotchSnap = 12;

/**
 * Moves the tab where the drag began by the pointer's travel: an edge tab slides along its edge and docks to
 * another edge once that one is clearly closer; a pill moves freely and stays inside the work area.
 */
export function draggedPlacement(
  area: Rectangle,
  current: DockedPlacement,
  tab: ActivityNotchRect,
  delta: { x: number; y: number },
  display: number,
): DockedPlacement {
  const x = tab.x + delta.x;
  const y = tab.y + delta.y;

  if (current.mode === "floating") {
    const free = { x: Math.max(1, area.width - tab.width), y: Math.max(1, area.height - tab.height) };
    let left = clamp(x - area.x, 0, free.x);

    if (Math.abs(left + tab.width / 2 - area.width / 2) <= activityNotchSnap) left = (area.width - tab.width) / 2;

    return { mode: "floating", x: left / free.x, y: clamp(y - area.y, 0, free.y) / free.y, display };
  }

  const point = { x: x + tab.width / 2, y: y + tab.height / 2 };

  const distances: [ActivityNotchEdge, number][] = [
    ["top", Math.abs(point.y - area.y)],
    ["bottom", Math.abs(bottomOf(area) - point.y)],
    ["left", Math.abs(point.x - area.x)],
    ["right", Math.abs(rightOf(area) - point.x)],
  ];

  // An edge keeps the tab until another is clearly closer, so a drag near a corner does not flip between them.
  const kept = distances.find(([edge]) => edge === current.edge)?.[1] ?? Infinity;
  const [nearest, distance] = distances.reduce((best, next) => (next[1] < best[1] ? next : best));
  const edge = distance < kept - activityNotchSnap ? nearest : current.edge;

  const along =
    edge === "top" || edge === "bottom" ? (point.x - area.x) / area.width : (point.y - area.y) / area.height;

  const span = edge === "top" || edge === "bottom" ? area.width : area.height;
  const offset = Math.abs(along - 0.5) * span <= activityNotchSnap ? 0.5 : clamp(along, 0, 1);

  return { mode: "edge", edge, offset, display };
}
