import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { subagentsOf } from "@canopy/domain/subagents";
import { applyThread } from "../../../api/thread";
import { useThreadRequests } from "../questions/QuestionPanel";
import { useQueue } from "./useQueue";

/** What the thread's tray shows and edits: its subagents, requests, queue and goal. */
export function useThreadTray({
  id,
  snapshot,
  setSnapshot,
  thread,
  threads,
}: {
  id: string;
  snapshot: ui.ThreadSnapshot | undefined;
  setSnapshot: (update: (previous: ui.ThreadSnapshot | undefined) => ui.ThreadSnapshot | undefined) => void;
  thread: ui.Thread | undefined;
  threads: readonly ui.Thread[];
}) {
  /** The queued message open in the editor. */
  const [editing, setEditing] = useState<ui.Turn>();
  const [dismissedGoals, setDismissedGoals] = useState<ReadonlySet<string>>(new Set());
  // Every subagent's requests reach the parent; only working ones are listed in the tray.
  const subagents = threads.filter((t) => t.spawnedByAgent && t.parentThreadId === id && !t.deletedAt);
  const interactions = snapshot?.interactions.filter((i) => i.status === "pending") ?? [];

  const queue = useQueue({
    threadId: id,
    turns: snapshot?.turns ?? [],
    steers: snapshot?.steers ?? [],
    running: thread?.status === "running",
    apply: (update) => setSnapshot((current) => applyThread(current, update)),
  });

  return {
    subagents,
    activeSubagents: subagentsOf(threads, id),
    interactions,
    requests: useThreadRequests(interactions, subagents),
    queue,
    editing,
    setEditing,
    dismissedGoals,
    dismissGoal: (goalId: string) => setDismissedGoals((current) => new Set(current).add(goalId)),
  };
}
