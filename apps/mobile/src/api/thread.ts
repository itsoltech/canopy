import type { ui } from "@canopy/contracts";

export { applyThreadUpdate as applyThread } from "@canopy/domain/thread-snapshot";

interface ThreadStatus {
  label: string;
  tone: "active" | "attention" | "muted";
}

export function threadStatus(thread: ui.Thread): ThreadStatus {
  if (thread.pendingInteractions || thread.status === "waiting_input")
    return { label: "Needs input", tone: "attention" };

  if (["creating", "running"].includes(thread.status)) return { label: "Running", tone: "active" };

  if (thread.status === "failed") return { label: "Failed", tone: "attention" };

  return { label: thread.status === "interrupted" ? "Interrupted" : "Idle", tone: "muted" };
}
