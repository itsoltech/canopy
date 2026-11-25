import { ipcRenderer } from "electron";
import type { ActivityNotchRow } from "../src/activity-notch.ts";

export interface ActivityNotchProbe {
  rows: readonly ActivityNotchRow[];
  sandboxed: boolean;
  contextIsolated: boolean;
}

// Observe the payload at the IPC boundary before the production preload projects it again.
ipcRenderer.on("canopy:activity-notch-rows", (_event, rows: readonly ActivityNotchRow[]) => {
  ipcRenderer.send("activity-notch-fixture:received-rows", {
    rows,
    sandboxed: process.sandboxed,
    contextIsolated: process.contextIsolated,
  } satisfies ActivityNotchProbe);
});

ipcRenderer.on("canopy:activity-notch-height", (_event, height: number) => {
  ipcRenderer.send("activity-notch-fixture:received-height", height);
});
