/** Keep readers, never draft text, file names or secrets. Settings may leave composers mounted underneath. */
const readers = new Set<() => boolean>();

export function registerUnsentWork(read: () => boolean) {
  readers.add(read);

  return () => {
    readers.delete(read);
  };
}

export const hasUnsentWork = () => [...readers].some((read) => read());
