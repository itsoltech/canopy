/**
 * Live WebViews are bounded: one at a time on this app (docs/agent-visuals.md §4). A visual mounts by itself only
 * when the slot is free; "Open visual" (an explicit request) takes it from a visual that isn't in full screen.
 */
export interface VisualSlot {
  /** The visual holding the slot is in full screen; it is never taken away. */
  pinned(): boolean;
  /** Called when another visual takes the slot. */
  evict(): void;
}

const CAPACITY = 1;
const held: VisualSlot[] = [];
const waiting = new Set<() => void>();

export function claimVisualSlot(slot: VisualSlot, force: boolean): boolean {
  if (held.includes(slot)) return true;

  if (held.length >= CAPACITY) {
    if (!force) return false;
    const victim = held.find((other) => !other.pinned());

    if (!victim) return false;
    releaseVisualSlot(victim);
    victim.evict();
  }

  held.push(slot);

  return true;
}

export function releaseVisualSlot(slot: VisualSlot): void {
  const index = held.indexOf(slot);

  if (index < 0) return;
  held.splice(index, 1);

  for (const retry of Array.from(waiting)) retry();
}

/** A visible placeholder retries when the slot frees up. */
export function waitForVisualSlot(retry: () => void): () => void {
  waiting.add(retry);

  return () => waiting.delete(retry);
}
