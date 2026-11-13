import type { SidebarEntry } from "@canopy/domain/sidebar-entries";

export interface DragItem {
  group: string;
  naturalGroup: string;
  project: string;
  pinned: boolean;
  local: boolean;
}

export interface RowBox {
  top: number;
  height: number;
}

export interface DropTarget {
  id: string;
  before: boolean;
  line: number;
}

export function dragItems(entries: readonly SidebarEntry[], natural: readonly SidebarEntry[], pins: readonly string[]) {
  let group = "";
  const naturalGroups = new Map<string, string>();

  for (const entry of natural) {
    if (entry.heading) group = entry.key;

    if (entry.thread) naturalGroups.set(entry.key, group);
  }

  const result: Record<string, DragItem> = {};

  for (const entry of entries) {
    if (entry.heading) group = entry.key;

    if (entry.thread)
      result[entry.key] = {
        group,
        naturalGroup: naturalGroups.get(entry.key) ?? "",
        project: entry.thread.projectId,
        pinned: pins.includes(entry.key),
        local: !entry.thread.nodeId,
      };
  }

  return result;
}

export function rowAt(boxes: Record<string, RowBox>, y: number): string {
  "worklet";

  for (const id of Object.keys(boxes)) {
    const box = boxes[id];

    if (box && y >= box.top && y < box.top + box.height) return id;
  }

  return "";
}

export function dropAt(
  boxes: Record<string, RowBox>,
  items: Record<string, DragItem>,
  id: string,
  y: number,
  grouped: boolean,
): DropTarget {
  "worklet";
  const target = rowAt(boxes, y);
  const from = items[id];
  const to = items[target];
  const box = boxes[target];
  const invalid = { id: "", before: true, line: -1 };

  if (!from || !to || !box || id === target || !to.local) return invalid;
  const sameProject = !grouped || to.pinned || from.project === to.project;
  const sameGroup = from.group === to.group || to.pinned || (from.pinned && from.naturalGroup === to.group);

  if (!sameProject || !sameGroup) return invalid;
  const before = y < box.top + box.height / 2;

  return { id: target, before, line: before ? box.top : box.top + box.height };
}
