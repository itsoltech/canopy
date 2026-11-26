import { contextBridge, ipcRenderer } from "electron";
import type { ActivityNotchRow } from "./activity-notch.ts";
import type { ActivityNotchLayout } from "./activity-notch-geometry.ts";

type RowsListener = (rows: readonly ActivityNotchRow[], revision: number) => void;

let latestActivity: { rows: readonly ActivityNotchRow[]; revision: number } | undefined;
let rowsListener: RowsListener | undefined;
let layout: ActivityNotchLayout | undefined;
let layoutListener: ((layout: ActivityNotchLayout) => void) | undefined;
let collapseListener: (() => void) | undefined;

ipcRenderer.on("canopy:activity-notch-rows", (_event, rows: readonly ActivityNotchRow[], revision: number) => {
  const sanitized = rows.map(({ id, label, state, projectMark }) => {
    const row = { id, label, state };

    if (!projectMark) return row;
    const { initials, foreground, background, pixels } = projectMark;

    return { ...row, projectMark: { initials, foreground, background, ...(pixels && { pixels }) } };
  });

  latestActivity = { rows: sanitized, revision };
  rowsListener?.(sanitized, revision);
});

ipcRenderer.on("canopy:activity-notch-collapse", () => collapseListener?.());

ipcRenderer.on("canopy:activity-notch-layout", (_event, next: ActivityNotchLayout) => {
  layout = next;
  layoutListener?.(next);
});

contextBridge.exposeInMainWorld("canopyActivityNotch", {
  onRows(listener: RowsListener) {
    rowsListener = listener;

    if (latestActivity) listener(latestActivity.rows, latestActivity.revision);
  },
  onCollapse(listener: () => void) {
    collapseListener = listener;
  },
  onLayout(listener: (layout: ActivityNotchLayout) => void) {
    layoutListener = listener;

    if (layout) listener(layout);
  },
  layoutSettled(revision: number) {
    if (Number.isSafeInteger(revision)) ipcRenderer.send("canopy:activity-notch-layout-settled", revision);
  },
  hidden(revision: number) {
    if (Number.isSafeInteger(revision)) ipcRenderer.send("canopy:activity-notch-hidden", revision);
  },
  setExpanded(expanded: boolean) {
    if (expanded === true || expanded === false) ipcRenderer.send("canopy:activity-notch-expanded", expanded);
  },
  open(id: number) {
    if (Number.isSafeInteger(id)) ipcRenderer.send("canopy:activity-notch-open", id);
  },
});
