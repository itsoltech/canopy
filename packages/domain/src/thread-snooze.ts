import type { ui } from "@canopy/contracts";

type SnoozePreset = 1 | 2 | 6 | "today" | "indefinite";

export const snoozePresets: readonly { value: SnoozePreset; label: string }[] = [
  { value: 1, label: "1 hour" },
  { value: 2, label: "2 hours" },
  { value: 6, label: "6 hours" },
  { value: "today", label: "Until end of day" },
  { value: "indefinite", label: "Until I wake it" },
];

export function snoozeDeadline(preset: SnoozePreset, now = new Date()): Date | undefined {
  if (preset === "indefinite") return undefined;

  if (preset === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  return new Date(now.getTime() + preset * 3_600_000);
}

/** A snoozed ancestor keeps its entire tree quiet, including pinned side threads. */
export function isThreadSnoozed(thread: ui.Thread, lookup?: (id: string) => ui.Thread | undefined): boolean {
  if (thread.snoozed) return true;

  if (!lookup || !thread.parentThreadId) return false;

  const visited = new Set([thread.id]);
  let parentId = thread.parentThreadId;

  while (parentId && !visited.has(parentId)) {
    const parent = lookup(parentId);

    if (!parent) return false;

    if (parent.snoozed && parent.status !== "archived" && !parent.deletedAt) return true;
    visited.add(parentId);
    parentId = parent.parentThreadId;
  }

  return false;
}
