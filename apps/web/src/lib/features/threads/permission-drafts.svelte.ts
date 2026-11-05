import type { PermissionModeKey } from "./labels.ts";

/**
 * The permission mode picked in a composer of a thread that does not exist yet (new thread, side thread), for this
 * tab (nothing is stored in the browser): leaving the page and coming back keeps the pick; creating the thread clears
 * it. Unset = the defaults (Settings → Threads, or the main thread's mode for a side thread).
 *
 *   const drafts = usePermissionDrafts();
 *   drafts.get(NEW_THREAD) ?? fromDefaults
 *   drafts.set(sideThreadDraft(mainId), "FULL_AUTO")  /  drafts.clear(key)
 */
export class PermissionDrafts {
  #byKey = $state.raw<ReadonlyMap<string, PermissionModeKey>>(new Map());

  get(key: string): PermissionModeKey | undefined {
    return this.#byKey.get(key);
  }

  set(key: string, mode: PermissionModeKey): void {
    this.#byKey = new Map(this.#byKey).set(key, mode);
  }

  clear(key: string): void {
    if (!this.#byKey.has(key)) return;
    const next = new Map(this.#byKey);
    next.delete(key);
    this.#byKey = next;
  }
}

export const NEW_THREAD = "new";
export const sideThreadDraft = (mainThreadId: string) => `side:${mainThreadId}`;

const drafts = new PermissionDrafts();

/** The tab's permission drafts (one store for the new-thread and side-thread pages). */
export function usePermissionDrafts(): PermissionDrafts {
  return drafts;
}
