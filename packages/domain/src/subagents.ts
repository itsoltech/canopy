import type { ui } from "@canopy/contracts";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { byActivity } from "./thread-activity.ts";
import type { StatusLook } from "./status-look.ts";

export type SubagentState = "working" | "waiting" | "completed" | "failed" | "interrupted";

const looks: Record<SubagentState, StatusLook> = {
  working: { label: "Working", tone: "sky", active: true },
  waiting: { label: "Waiting for an answer", tone: "amber", active: true },
  completed: { label: "Completed", tone: "emerald" },
  failed: { label: "Failed", tone: "rose" },
  interrupted: { label: "Interrupted", tone: "orange" },
};

export const subagentLook = (state: SubagentState): StatusLook => looks[state];

/** Terminal threads cannot be revived by a stale pending-interaction count. */
export function isActiveSubagent(thread: ui.Thread): boolean {
  if (!["creating", "running", "waiting_input", "idle"].includes(thread.status)) return false;

  return thread.status !== "idle" || thread.pendingInteractions > 0;
}

/** Live work first, then the last turn's outcome, including after the thread is archived. */
export function subagentState(thread: ui.Thread): SubagentState {
  if (isActiveSubagent(thread))
    return thread.pendingInteractions > 0 || thread.status === "waiting_input" ? "waiting" : "working";

  if (thread.status === "failed") return "failed";

  switch (thread.lastTurnStatus) {
    case "completed":
    case "failed":
    case "interrupted":
      return thread.lastTurnStatus;
  }

  return thread.status === "interrupted" ? "interrupted" : "completed";
}

/** The same active/recent/finished groups on web and mobile; recent means 10 minutes since last activity. */
export function subagentLineage(threads: readonly ui.Thread[], now: number, showFinished: boolean) {
  const agents = threads.filter((thread) => thread.spawnedByAgent && !thread.deletedAt);
  const active = agents.filter(isActiveSubagent).sort(byActivity);
  const finished = agents.filter((thread) => !isActiveSubagent(thread)).sort(byActivity);

  const recent = (thread: ui.Thread) => {
    const at = thread.lastActivityAt ?? thread.createdAt;

    return at !== undefined && now - timestampMs(at) < 10 * 60 * 1000;
  };

  return {
    running: active.filter((thread) => subagentState(thread) === "working").length,
    waiting: active.filter((thread) => subagentState(thread) === "waiting").length,
    finished: finished.length,
    collapsed: showFinished ? [] : finished,
    current: [...active, ...(showFinished ? finished.filter(recent) : [])],
    previous: showFinished ? finished.filter((thread) => !recent(thread)) : [],
  };
}
