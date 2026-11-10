import type { ui } from "@canopy/contracts";
import type { SidebarEntry } from "./sidebar-entries.ts";
import { sameItems } from "./same-items.ts";
import { sidebarChildren } from "./sidebar-threads.ts";

type Sides = ReturnType<typeof sidebarChildren>["sides"];

/** Everything one inbox row shows, so a row can skip an update that leaves all of it unchanged. */
export interface SidebarRow {
  readonly key: string;
  readonly thread?: ui.Thread | undefined;
  readonly heading?: string | undefined;
  readonly working?: boolean | undefined;
  readonly project?: ui.Project | undefined;
  readonly worker?: ui.Worker | undefined;
  readonly sides: Sides;
  readonly subagentsNeedingInput: readonly ui.Thread[];
  /** Its side threads are listed under it (the open thread's tree). */
  readonly open: boolean;
}

export const sameSidebarRow = (a: SidebarRow, b: SidebarRow): boolean =>
  a.key === b.key &&
  a.thread === b.thread &&
  a.heading === b.heading &&
  a.working === b.working &&
  a.project === b.project &&
  a.worker === b.worker &&
  a.open === b.open &&
  sameItems(a.sides.active, b.sides.active) &&
  sameItems(a.sides.previous, b.sides.previous) &&
  sameItems(a.subagentsNeedingInput, b.subagentsNeedingInput);

const NONE: readonly ui.Thread[] = [];

export function sidebarRows(
  entries: readonly SidebarEntry[],
  filtered: { sides: ReadonlyMap<string, readonly ui.Thread[]>; roots: readonly ui.Thread[] },
  openTree: string | undefined,
  lookup: { project: (id: string) => ui.Project | undefined; worker: (id: string) => ui.Worker | undefined },
): SidebarRow[] {
  const rootIds = new Set(filtered.roots.map((t) => t.id));

  return entries.map((entry) => {
    const thread = entry.thread;

    const { sides, subagentsNeedingInput } = sidebarChildren(
      thread ? (filtered.sides.get(thread.id) ?? NONE) : NONE,
      rootIds,
    );

    return {
      key: entry.key,
      thread,
      heading: entry.heading,
      working: entry.working,
      project: thread && lookup.project(thread.projectId),
      worker: thread && lookup.worker(thread.workerId),
      sides,
      subagentsNeedingInput,
      open: thread !== undefined && thread.id === openTree,
    };
  });
}
