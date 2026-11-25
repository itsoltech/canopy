import { contextBridge, ipcRenderer } from "electron";
import type { ActivityNotchRow } from "./activity-notch.ts";

let latestRows: readonly ActivityNotchRow[] | undefined;
let rowsListener: ((rows: readonly ActivityNotchRow[]) => void) | undefined;
let collapseListener: (() => void) | undefined;

ipcRenderer.on("canopy:activity-notch-rows", (_event, rows: readonly ActivityNotchRow[]) => {
  latestRows = rows.map(({ id, kind, number, state }) => ({ id, kind, number, state }));
  rowsListener?.(latestRows);
});

ipcRenderer.on("canopy:activity-notch-collapse", () => collapseListener?.());

contextBridge.exposeInMainWorld("canopyActivityNotch", {
  onRows(listener: (rows: readonly ActivityNotchRow[]) => void) {
    rowsListener = listener;

    if (latestRows) listener(latestRows);
  },
  onCollapse(listener: () => void) {
    collapseListener = listener;
  },
  setExpanded(expanded: boolean) {
    if (expanded === true || expanded === false) ipcRenderer.send("canopy:activity-notch-expanded", expanded);
  },
  open(id: number) {
    if (Number.isSafeInteger(id)) ipcRenderer.send("canopy:activity-notch-open", id);
  },
});
