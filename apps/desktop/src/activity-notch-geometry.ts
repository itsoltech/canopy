import type { Rectangle } from "electron";

export const activityNotchGapWidth = 200;
export const activityNotchSimulatedHeight = 32;
export const activityNotchWingWidth = 40;
export const activityNotchEarWidth = 8;
export const activityNotchExpandedWidth = 480;

/** Three lines, as in the sidebar: project, title, then worker, branch and provider. */
export const activityNotchRowHeight = 72;

export const activityNotchBottomInset = 8;
export const activityNotchVisibleRows = 5;

export interface ActivityNotchCutout {
  center: number;
  width: number;
  height: number;
}

/** The compact tab on an edge: two wings and a small gap, so it hides little of the window below it. */
export const activityNotchTabGap = 8;
export const activityNotchTabLength = 2 * activityNotchWingWidth + activityNotchTabGap;

/** The floating pill adds a grip before its wings; the margin holds its shadow inside the window. */
export const activityNotchGripWidth = 16;
export const activityNotchFloatingMargin = 24;

export interface ActivityNotchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The screen edge the outline is attached to, or none when it floats. */
export type ActivityNotchSide = "top" | "right" | "bottom" | "left" | "float";

/** Where the renderer draws the outline. Rectangles are relative to the native window. */
export interface ActivityNotchLayout {
  revision: number;
  side: ActivityNotchSide;
  /** The header sits on the side the outline grows away from: the top, or the bottom when it opens upward. */
  header: "start" | "end";
  draggable: boolean;
  expanded: boolean;
  /** Applies without a transition: the native window moved with this change. */
  moving: boolean;
  headerHeight: number;
  /** The outline for the rows on show. */
  shape: ActivityNotchRect;
  /** The compact outline, where the panel grows from. */
  tab: ActivityNotchRect;
  /** The open list below or above the header; it keeps this place while the outline shrinks. */
  list: ActivityNotchRect;
}

/** Height of the list for this many rows: five rows show at once, the rest scroll. */
export function activityNotchRowsHeight(rows: number) {
  return rows ? Math.min(rows, activityNotchVisibleRows) * activityNotchRowHeight + activityNotchBottomInset : 0;
}

export function activityNotchGeometry(
  display: { bounds: Rectangle; workArea: Rectangle },
  expandedRows: number,
  menuBand?: { cutout?: ActivityNotchCutout | undefined },
  compactHeight = activityNotchSimulatedHeight,
) {
  const { bounds, workArea } = display;
  const cutout = menuBand?.cutout;
  const area = menuBand ? bounds : workArea;
  const center = bounds.x + (cutout?.center ?? bounds.width / 2);
  const y = area.y;
  const availableHeight = workArea.y + workArea.height - y;
  const menuHeight = menuBand ? workArea.y - bounds.y : 0;

  const headerHeight = Math.min(availableHeight, Math.ceil(Math.max(menuHeight, cutout?.height ?? 0) || compactHeight));

  // Allow for DIP rounding when centering the two wings around the camera.
  const gap = Math.max(activityNotchGapWidth, cutout ? Math.ceil(cutout.width) + 2 : 0);
  const compactWidth = gap + 2 * activityNotchWingWidth;
  const panelWidth = expandedRows ? Math.max(activityNotchExpandedWidth, compactWidth) : compactWidth;
  const width = Math.min(area.width, panelWidth + 2 * activityNotchEarWidth);
  const x = Math.min(area.x + area.width - width, Math.max(area.x, Math.round(center - width / 2)));

  const rowsHeight = activityNotchRowsHeight(expandedRows);

  return { bounds: { x, y, width, height: Math.min(availableHeight, headerHeight + rowsHeight) }, headerHeight };
}
