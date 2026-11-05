import type { ui } from "@canopy/contracts";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { byActivity } from "../activity.ts";
import { isActiveSubagent, subagentState } from "./subagents.ts";

/** Finished work stays recent for 10 minutes after its last activity, independent of archive time. */
const RECENT_MS = 10 * 60 * 1000;

export function subagentLineage(threads: readonly ui.Thread[], now: number, showFinished: boolean) {
  const agents = threads.filter((thread) => thread.spawnedByAgent && !thread.deletedAt);
  const active = agents.filter(isActiveSubagent).sort(byActivity);
  const finished = agents.filter((thread) => !isActiveSubagent(thread)).sort(byActivity);

  const recent = (thread: ui.Thread) => {
    const at = thread.lastActivityAt ?? thread.createdAt;

    return at !== undefined && now - timestampMs(at) < RECENT_MS;
  };

  return {
    running: active.filter((thread) => subagentState(thread) === "working").length,
    waiting: active.filter((thread) => subagentState(thread) === "waiting").length,
    finished: finished.length,
    current: [...active, ...(showFinished ? finished.filter(recent) : [])],
    previous: showFinished ? finished.filter((thread) => !recent(thread)) : [],
  };
}
