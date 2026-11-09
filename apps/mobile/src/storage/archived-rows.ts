import type { ui } from "@canopy/contracts";
import type { ArchivedFilter, ArchivedPageState } from "@canopy/domain/archived-threads";
import { isArchivedSidebarThread } from "@canopy/domain/sidebar-threads";

/** Keep known rows in place; insert new archives in gateway keyset order without sorting the list. */
export function mergeArchivedThread(
  state: ArchivedPageState,
  thread: ui.Thread,
  filter: ArchivedFilter,
  projects: readonly ui.Project[],
): ArchivedPageState {
  const index = state.threads.findIndex((row) => row.id === thread.id);
  const query = filter.query.trim().toLowerCase();
  const project = projects.find((project) => project.id === thread.projectId)?.name ?? "";

  const matches =
    isArchivedSidebarThread(thread) &&
    (!filter.projectIds.length || filter.projectIds.includes(thread.projectId)) &&
    (!query || `${thread.title} ${project}`.toLowerCase().includes(query));

  const child = thread.parentThreadId && state.threads.some((row) => row.id === thread.parentThreadId);

  if (
    index < 0 &&
    !child &&
    !state.sideThreads.some((row) => row.id === thread.id) &&
    (!matches || thread.parentThreadId)
  )
    return state;
  const rows = state.threads.filter((row) => row.id !== thread.id);

  if (matches && (!thread.parentThreadId || index >= 0)) {
    const position = index >= 0 ? index : insertionIndex(rows, thread);
    rows.splice(position, 0, thread);
  }

  const roots = new Set(rows.map((row) => row.id));
  const sides = state.sideThreads.filter((row) => row.id !== thread.id && roots.has(row.parentThreadId));

  if (thread.parentThreadId && !thread.deletedAt && roots.has(thread.parentThreadId)) sides.push(thread);

  return {
    ...state,
    threads: rows,
    sideThreads: sides,
    totalCount:
      state.totalCount === undefined ? undefined : Math.max(0, state.totalCount + rows.length - state.threads.length),
  };
}

function insertionIndex(rows: ui.Thread[], thread: ui.Thread) {
  let low = 0;
  let high = rows.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if (before(thread, rows[middle]!)) high = middle;
    else low = middle + 1;
  }

  return low;
}

function before(a: ui.Thread, b: ui.Thread) {
  const seconds = (a.archivedAt?.seconds ?? 0n) - (b.archivedAt?.seconds ?? 0n);
  const nanos = (a.archivedAt?.nanos ?? 0) - (b.archivedAt?.nanos ?? 0);

  return seconds > 0n || (seconds === 0n && (nanos > 0 || (nanos === 0 && a.id > b.id)));
}

/** Both inputs already follow the archive cursor: merge in linear time, with stable keys. */
export function mergeSavedPeers(local: ui.Thread[], peers: ui.Thread[]) {
  const rows: ui.Thread[] = [];
  let index = 0;

  for (const thread of local) {
    while (index < peers.length && before(peers[index]!, thread)) rows.push(peers[index++]!);
    rows.push(thread);
  }

  rows.push(...peers.slice(index));

  return rows;
}
