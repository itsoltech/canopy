/** View-local invalidations. Only mounted pages subscribe; logs never subscribe or prefetch. */
export class PullRequestInvalidations {
  readonly listeners = new Map<string, Set<() => void>>();
  subscribe(id: string, listener: () => void) {
    const entries = this.listeners.get(id) ?? new Set();
    entries.add(listener);
    this.listeners.set(id, entries);

    return () => {
      entries.delete(listener);

      if (!entries.size) this.listeners.delete(id);
    };
  }
  publish(id: string) {
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
}
