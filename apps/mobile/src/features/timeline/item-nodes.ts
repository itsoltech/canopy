import type { Item } from "@canopy/contracts";

/** An item with the items that name it as parent (subagent work), as the timeline builds it. */
export interface ItemNode {
  readonly item: Item;
  readonly children: readonly ItemNode[];
}

/** Nests items under their parents, keeping order; unknown parents leave an item on top. */
export function itemNodes(items: readonly Item[]): ItemNode[] {
  const ids = new Set(items.map((i) => i.itemId));
  const children = new Map<string, Item[]>();
  const top: Item[] = [];

  for (const item of items) {
    const parent = item.parentItemId;

    if (!parent || parent === item.itemId || !ids.has(parent)) top.push(item);
    else children.set(parent, [...(children.get(parent) ?? []), item]);
  }

  const node = (item: Item, seen: Set<string>): ItemNode => {
    seen.add(item.itemId);

    return {
      item,
      children: (children.get(item.itemId) ?? []).filter((c) => !seen.has(c.itemId)).map((c) => node(c, seen)),
    };
  };

  return top.map((item) => node(item, new Set()));
}
