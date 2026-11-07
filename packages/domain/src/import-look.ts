import type { StatusLook } from "./status-look.ts";
import type { ui } from "@canopy/contracts";

/** Words and tones of CLI imports (docs/import.md, docs/copy.md), shared by the web app and the phone app. */

const RUNS = new Map<string, StatusLook>([
  ["running", { label: "Importing", tone: "sky", active: true }],
  ["paused", { label: "Paused", tone: "amber" }],
  ["completed", { label: "Done", tone: "emerald" }],
  ["failed", { label: "Failed", tone: "rose" }],
  ["cancelled", { label: "Cancelled", tone: "neutral" }],
  ["undone", { label: "Removed", tone: "neutral" }],
]);

const ITEMS = new Map([
  ["pending", "Waiting"],
  ["importing", "Importing"],
  ["done", "Imported"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
  ["undone", "Removed"],
  ["kept", "Kept: changed since"],
]);

const CLIS = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["grok", "Grok"],
]);

/** An import run's status (`ui.ImportRun.status`). */
export function importRunLook(status: string): StatusLook {
  return RUNS.get(status) ?? { label: status, tone: "neutral" };
}

/** A thread's or setting's status within a run. */
export function importItemLabel(status: string): string {
  return ITEMS.get(status) ?? status;
}

export function agentCliName(agentCli: string): string {
  return CLIS.get(agentCli) ?? agentCli;
}

/** Match the gateway's terminal states; failed restores remain done and can be removed again. */
export function importRunActions(run: ui.ImportRun) {
  const settingsDone = run.library.filter((item) => item.status === "done").length;
  const failed = run.failed + run.library.filter((item) => item.status === "failed").length;

  return {
    active: run.status === "running" || run.status === "paused",
    retry: run.status === "paused" || (["completed", "failed"].includes(run.status) && failed > 0),
    removable: run.status === "undone" ? settingsDone > 0 : run.done > 0 || settingsDone > 0,
    settingsDone,
    failed,
  };
}
