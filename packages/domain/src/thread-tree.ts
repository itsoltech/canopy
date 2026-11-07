import { ui } from "@canopy/contracts";

export const isSide = (thread: ui.Thread) => thread.kind === ui.ThreadKind.SIDE || Boolean(thread.parentThreadId);

/** Shared by sidebar and Lineage; deleted threads are never a previous agent. */
export function groupSideThreads(threads: readonly ui.Thread[]) {
  const visible = threads.filter((t) => !t.deletedAt);

  return {
    active: visible
      .filter((t) => t.status !== "archived")
      .sort((a, b) => Number((a.createdAt?.seconds ?? 0n) - (b.createdAt?.seconds ?? 0n))),
    previous: visible
      .filter((t) => t.status === "archived")
      .sort((a, b) =>
        Number(
          (b.archivedAt?.seconds ?? b.createdAt?.seconds ?? 0n) - (a.archivedAt?.seconds ?? a.createdAt?.seconds ?? 0n),
        ),
      ),
  };
}
