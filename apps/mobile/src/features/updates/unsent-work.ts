/** Readers retain no draft contents here. Reload checks the current values synchronously. */
const readers = new Set<() => boolean>();

export function registerUnsentWork(read: () => boolean) {
  readers.add(read);

  return () => {
    readers.delete(read);
  };
}

export const hasUnsentWork = () => [...readers].some((read) => read());
