/**
 * Live visual frames are bounded: two on larger screens, one on phones. A visual mounts by itself only when a slot
 * is free; "Open visual" (an explicit request) takes the oldest slot whose frame doesn't hold focus.
 */
export interface VisualSlot {
  /** The frame holding the slot has focus; it is never taken away. */
  focused(): boolean;
  /** Called when another visual takes the slot. */
  evict(): void;
}

const held: VisualSlot[] = [];
const waiting = new Set<() => void>();

const capacity = () => (matchMedia("(max-width: 40rem), (pointer: coarse) and (max-width: 48rem)").matches ? 1 : 2);

export function claimVisualSlot(slot: VisualSlot, force: boolean): boolean {
  if (held.includes(slot)) return true;

  if (held.length >= capacity()) {
    if (!force) return false;
    const victim = held.find((other) => !other.focused());

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

/** A visible placeholder retries when a slot frees up. */
export function waitForVisualSlot(retry: () => void): () => void {
  waiting.add(retry);

  return () => waiting.delete(retry);
}
