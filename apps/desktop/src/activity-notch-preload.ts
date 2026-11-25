import { contextBridge, ipcRenderer } from "electron";
import type { ActivityNotchRow } from "./activity-notch.ts";
import { activityNotchSimulatedHeight } from "./activity-notch-geometry.ts";

let latestRows: readonly ActivityNotchRow[] | undefined;
let rowsListener: ((rows: readonly ActivityNotchRow[]) => void) | undefined;
let headerHeight = activityNotchSimulatedHeight;
let heightListener: ((height: number) => void) | undefined;
let collapseListener: (() => void) | undefined;

ipcRenderer.on("canopy:activity-notch-rows", (_event, rows: readonly ActivityNotchRow[]) => {
  latestRows = rows.map(({ id, kind, number, state, projectMark }) => {
    const row = { id, kind, number, state };

    if (!projectMark) return row;
    const { initials, foreground, background, pixels } = projectMark;

    return { ...row, projectMark: { initials, foreground, background, ...(pixels && { pixels }) } };
  });
  rowsListener?.(latestRows);
});

ipcRenderer.on("canopy:activity-notch-collapse", () => collapseListener?.());

ipcRenderer.on("canopy:activity-notch-height", (_event, height: number) => {
  headerHeight = height;
  heightListener?.(height);
});

contextBridge.exposeInMainWorld("canopyActivityNotch", {
  onRows(listener: (rows: readonly ActivityNotchRow[]) => void) {
    rowsListener = listener;

    if (latestRows) listener(latestRows);
  },
  onCollapse(listener: () => void) {
    collapseListener = listener;
  },
  onHeight(listener: (height: number) => void) {
    heightListener = listener;
    listener(headerHeight);
  },
  setExpanded(expanded: boolean) {
    if (expanded === true || expanded === false) ipcRenderer.send("canopy:activity-notch-expanded", expanded);
  },
  open(id: number) {
    if (Number.isSafeInteger(id)) ipcRenderer.send("canopy:activity-notch-open", id);
  },
});
