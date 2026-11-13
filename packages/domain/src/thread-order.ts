import type { ui } from "@canopy/contracts";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import type { SidebarEntry } from "./sidebar-entries.ts";

export type ThreadSortMode = "activity" | "created" | "custom";

export const threadSortModes = [
  { value: "activity", label: "Last activity" },
  { value: "created", label: "Created" },
  { value: "custom", label: "Custom" },
] as const;

const time = (at: Timestamp | undefined) => (at?.seconds ?? 0n) * 1_000_000_000n + BigInt(at?.nanos ?? 0);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Same fallback as thread_creation_order in SQL; no writes or settings-sized id lists for old threads. */
export function manualThreadKey(thread: ui.Thread): string {
  if (thread.sidebarOrderKey) return thread.sidebarOrderKey;
  const milliseconds = time(thread.createdAt) / 1_000_000n;

  const reverseId = thread.id
    .replaceAll("-", "")
    .replace(/[0-9a-f]/gi, (digit) => (15 - Number.parseInt(digit, 16)).toString(16));

  return `a0V${(281474976710655n - milliseconds).toString(16).padStart(12, "0")}${reverseId}V`;
}

export function compareThreadOrder(a: ui.Thread, b: ui.Thread, mode: ThreadSortMode): number {
  if (mode === "custom") {
    // A remote arrangement is visible but only editable at its home. Keep each home's order together.
    const home = compare(a.nodeId, b.nodeId);

    if (home) return home;

    return compare(manualThreadKey(a), manualThreadKey(b)) || compare(b.id, a.id);
  }

  const at = mode === "created" ? a.createdAt : (a.lastReplyAt ?? a.createdAt);
  const bt = mode === "created" ? b.createdAt : (b.lastReplyAt ?? b.createdAt);

  return Number(time(bt) - time(at)) || compare(b.id, a.id);
}

/** Headings define drag boundaries. Pins are the explicit exception, handled as a pin action by the client. */
export function threadOrderGroup(entries: readonly SidebarEntry[], id: string): string {
  let group = "";

  for (const entry of entries) {
    if (entry.heading) group = entry.key;

    if (entry.thread?.id === id) return group;
  }

  return "";
}

export function threadMove(
  entries: readonly SidebarEntry[],
  id: string,
  targetId: string,
  before: boolean,
): { afterThreadId: string; beforeThreadId: string } | undefined {
  if (id === targetId) return;
  const group = threadOrderGroup(entries, id);

  if (!group || group !== threadOrderGroup(entries, targetId)) return;
  const own = entries.find((e) => e.thread?.id === id)?.thread;
  const target = entries.find((e) => e.thread?.id === targetId)?.thread;

  if (!own || !target || own.nodeId || target.nodeId) return;
  let section = "";

  const peers = entries.filter((entry) => {
    if (entry.heading) section = entry.key;

    return section === group && entry.thread && !entry.thread.nodeId && entry.key !== id;
  });

  const at = peers.findIndex((e) => e.thread?.id === targetId) + (before ? 0 : 1);

  return { afterThreadId: peers[at - 1]?.key ?? "", beforeThreadId: peers[at]?.key ?? "" };
}
