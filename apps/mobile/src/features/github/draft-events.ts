const listeners = new Map<string, Set<() => void>>();

export function subscribePrDraft(id: string, listener: () => void): () => void {
  let thread = listeners.get(id);

  if (!thread) {
    thread = new Set();
    listeners.set(id, thread);
  }

  thread.add(listener);

  return () => {
    thread.delete(listener);

    if (!thread.size) listeners.delete(id);
  };
}

export function publishPrDraft(id: string): void {
  for (const listener of listeners.get(id) ?? []) listener();
}
