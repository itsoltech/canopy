import { contextBridge, ipcRenderer } from "electron";
import type { ActivityNotchRow } from "./activity-notch.ts";
import type { ActivityNotchLayout } from "./activity-notch-geometry.ts";
import { rowMeta } from "./activity-notch-meta.ts";

type RowsListener = (rows: readonly ActivityNotchRow[], revision: number, notice: number | undefined) => void;

let latestActivity: { rows: readonly ActivityNotchRow[]; revision: number; notice: number | undefined } | undefined;
let rowsListener: RowsListener | undefined;
let layout: ActivityNotchLayout | undefined;
let layoutListener: ((layout: ActivityNotchLayout) => void) | undefined;
let collapseListener: (() => void) | undefined;

ipcRenderer.on(
  "canopy:activity-notch-rows",
  (_event, rows: readonly ActivityNotchRow[], revision: number, noticeId?: number) => {
    const sanitized = rows.map(({ id, label, meta, state, projectMark, botMascot }) => {
      const facts = meta && rowMeta(meta);
      const row = { id, label, ...(facts && { meta: facts }), state, ...(botMascot && { botMascot }) };

      if (!projectMark) return row;
      const { initials, foreground, background, pixels } = projectMark;

      return { ...row, projectMark: { initials, foreground, background, ...(pixels && { pixels }) } };
    });

    // The notice names one of the rows the page shows, or nothing.
    const notice = sanitized.some((row) => row.id === noticeId) ? noticeId : undefined;
    latestActivity = { rows: sanitized, revision, notice };
    rowsListener?.(sanitized, revision, notice);
  },
);

ipcRenderer.on("canopy:activity-notch-collapse", () => collapseListener?.());

ipcRenderer.on("canopy:activity-notch-layout", (_event, next: ActivityNotchLayout) => {
  layout = next;
  layoutListener?.(next);
});

contextBridge.exposeInMainWorld("canopyActivityNotch", {
  onRows(listener: RowsListener) {
    rowsListener = listener;

    if (latestActivity) listener(latestActivity.rows, latestActivity.revision, latestActivity.notice);
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
  setInteractive(interactive: boolean) {
    if (interactive === true || interactive === false)
      ipcRenderer.send("canopy:activity-notch-interactive", interactive);
  },
  setExpanded(expanded: boolean) {
    if (expanded === true || expanded === false) ipcRenderer.send("canopy:activity-notch-expanded", expanded);
  },
  dismissNotice(id: number) {
    if (Number.isSafeInteger(id)) ipcRenderer.send("canopy:activity-notch-dismiss", id);
  },
  /** Main reads the cursor itself; the page only reports the phase of a drag on the header. */
  drag(phase: "start" | "move" | "end") {
    if (phase === "start" || phase === "move" || phase === "end") ipcRenderer.send("canopy:activity-notch-drag", phase);
  },
  open(id: number) {
    if (Number.isSafeInteger(id)) ipcRenderer.send("canopy:activity-notch-open", id);
  },
});
