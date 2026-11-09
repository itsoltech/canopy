import type { ui } from "@canopy/contracts";

/** The loaded window only; unchanged turns retain their entries when another turn streams. */
export class TimelineEntries {
  #groups = new Map<string, readonly ui.TimelineItem[]>();

  build(items: readonly ui.TimelineItem[]) {
    const groups = new Map<string, ui.TimelineItem[]>();

    for (const item of items) {
      const key = `${item.fromThreadId}:${item.turnId}`;
      const group = groups.get(key);

      if (group) group.push(item);
      else groups.set(key, [item]);
    }

    const next = new Map<string, readonly ui.TimelineItem[]>();

    for (const [key, group] of groups) {
      const previous = this.#groups.get(key);
      next.set(
        key,
        previous?.length === group.length && group.every((item, i) => item === previous[i]) ? previous : group,
      );
    }

    this.#groups = next;

    return next;
  }
}
