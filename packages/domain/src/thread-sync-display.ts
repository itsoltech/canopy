import type { ui } from "@canopy/contracts";
import { formatCount } from "./format.ts";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { formatRelative } from "./relative-time.ts";
import { formatPresenceTime } from "./computer-presence.ts";

/** Shared progress copy; diagnostics may show titles, never message bodies. */
export function threadSyncProgress(status: Pick<ui.ThreadSyncStatus, "caughtUp" | "remaining" | "reason">) {
  if (status.reason) return "Sync paused";

  if (status.caughtUp) return "Up to date";

  return `${status.remaining} ${status.remaining === 1n ? "record" : "records"} to go`;
}

/** The header indicator stays empty once the thread is caught up; it only reports work or a problem. */
export function threadSyncVisible(status: Pick<ui.ThreadSyncStatus, "caughtUp" | "reason">) {
  return Boolean(status.reason) || !status.caughtUp;
}

/** Tooltip and accessibility label: the failure reason when paused, otherwise the progress. */
export function threadSyncLabel(status: Pick<ui.ThreadSyncStatus, "caughtUp" | "remaining" | "reason">) {
  return status.reason ? `Sync paused: ${threadSyncFailure(status.reason)}` : threadSyncProgress(status);
}

export function threadSyncCount(remaining: bigint) {
  return remaining >= 999_500_000_000_000n ? ">999T" : formatCount(remaining);
}

export function threadSyncFailure(reason: string) {
  switch (reason) {
    case "decode_error":
      return "Unreadable update";
    case "size_limit":
      return "Update too large";
    case "invalid_range":
      return "Missing records";
    case "invalid_cursor":
      return "Sync position unavailable";
    case "invalid_record":
      return "Invalid update";
    case "access_denied":
      return "Access denied";
    case "thread_removed":
      return "Thread removed";
    case "timeout":
      return "Update timed out";
    case "stream_unavailable":
      return "Live updates unavailable";
    default:
      return "Sync paused";
  }
}

export function threadSyncRecords(remaining: bigint) {
  return `${remaining.toLocaleString("en")} ${remaining === 1n ? "record" : "records"} to go`;
}

export function threadSyncThreads(count: number) {
  return `${count.toLocaleString("en")} ${count === 1 ? "thread" : "threads"}`;
}

export function threadSyncLastTime(ms: bigint) {
  if (!ms) return "Sync time unavailable";

  const time =
    Date.now() - Number(ms) < 86_400_000 ? formatRelative(timestampFromMs(Number(ms))) : formatPresenceTime(ms);

  return `Last synced ${time}`;
}

export function threadSyncComputerStatus(computer: ui.ThreadSyncComputer) {
  if (!computer.reachable) return { label: "Unreachable", icon: "signal-slash" } as const;

  if (computer.pausedThreads) return { label: "Sync paused", icon: "pause" } as const;

  if (computer.syncingThreads) return { label: "Catching up", icon: "arrow-path" } as const;

  return { label: "Up to date", icon: "check" } as const;
}

export function threadSyncComputerSummary(computer: ui.ThreadSyncComputer) {
  const total = computer.threads.toLocaleString("en");
  const parts: string[] = [];

  if (computer.syncingThreads) parts.push(`${computer.syncingThreads.toLocaleString("en")} of ${total} catching up`);

  if (computer.pausedThreads)
    parts.push(`${computer.pausedThreads.toLocaleString("en")} ${parts.length ? "paused" : `of ${total} paused`}`);

  if (!parts.length) parts.push(`${threadSyncThreads(computer.threads)} · up to date`);

  if (computer.remaining) parts.push(threadSyncRecords(computer.remaining));

  return parts.join(" · ");
}

export function threadSyncTotals(syncing: number, paused: number, remaining: bigint) {
  const parts: string[] = [];

  if (syncing) parts.push(`${threadSyncThreads(syncing)} catching up`);

  if (paused) parts.push(`${threadSyncThreads(paused)} paused`);

  if (remaining) parts.push(threadSyncRecords(remaining));

  return parts.join(" · ");
}

/** Join bounded detail pages to complete computer totals, never infer totals from a thread page. */
export function groupThreadSyncDiagnostics(data: ui.ThreadSyncDiagnostics) {
  const entries = new Map<string, ui.ThreadSyncDiagnostic[]>();

  for (const entry of data.entries) {
    const group = entries.get(entry.computerNodeId) ?? [];
    group.push(entry);
    entries.set(entry.computerNodeId, group);
  }

  const computers = data.computers.map((computer) => ({
    computer,
    status: threadSyncComputerStatus(computer),
    summary: threadSyncComputerSummary(computer),
    entries: entries.get(computer.nodeId) ?? [],
  }));

  return {
    computers,
    allCaughtUp:
      computers.length > 0 &&
      computers.every(({ computer }) => computer.reachable && !computer.syncingThreads && !computer.pausedThreads),
    remaining: data.computers.reduce((sum, computer) => sum + computer.remaining, 0n),
    syncing: data.computers.reduce((sum, computer) => sum + computer.syncingThreads, 0),
    paused: data.computers.reduce((sum, computer) => sum + computer.pausedThreads, 0),
    lastSyncedAtMs: data.computers.reduce(
      (last, computer) => (computer.lastSyncedAtMs > last ? computer.lastSyncedAtMs : last),
      0n,
    ),
  };
}
