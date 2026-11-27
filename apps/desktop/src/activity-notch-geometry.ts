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

export interface ActivityNotchLayout {
  revision: number;
  center: number;
  width: number;
  height: number;
  headerHeight: number;
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

  const rowsHeight = expandedRows
    ? Math.min(expandedRows, activityNotchVisibleRows) * activityNotchRowHeight + activityNotchBottomInset
    : 0;

  return { bounds: { x, y, width, height: Math.min(availableHeight, headerHeight + rowsHeight) }, headerHeight };
}
