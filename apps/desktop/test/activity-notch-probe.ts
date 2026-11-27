import { ipcRenderer } from "electron";
import type { ActivityNotchLayout } from "../src/activity-notch-geometry.ts";
import type { ActivityNotchRow } from "../src/activity-notch.ts";

export interface ActivityNotchProbe {
  rows: readonly ActivityNotchRow[];
  notice: number | null | undefined;
  sandboxed: boolean;
  contextIsolated: boolean;
}

// Observe the payload at the IPC boundary before the production preload projects it again.
ipcRenderer.on(
  "canopy:activity-notch-rows",
  (_event, rows: readonly ActivityNotchRow[], _revision: number, notice?: number | null) => {
    ipcRenderer.send("activity-notch-fixture:received-rows", {
      rows,
      notice,
      sandboxed: process.sandboxed,
      contextIsolated: process.contextIsolated,
    } satisfies ActivityNotchProbe);
  },
);

ipcRenderer.on("canopy:activity-notch-layout", (_event, layout: ActivityNotchLayout) => {
  ipcRenderer.send("activity-notch-fixture:received-layout", layout);
});
