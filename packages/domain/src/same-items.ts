/** The same items in the same order, whatever the arrays' identity: derived lists keep their readers quiet. */
export const sameItems = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is): boolean =>
  a === b ||
  (a.length === b.length &&
    a.every((item, at) => {
      const other = b[at];

      return other !== undefined && same(item, other);
    }));

/**
 * Returns the value it was given last while `same` holds: a `$derived` (or memo) that rebuilds equal data from a
 * live index keeps its old value, so nothing downstream reruns.
 */
export function retain<T>(same: (a: T, b: T) => boolean): (next: T) => T {
  let last: { value: T } | undefined;

  return (next) => {
    if (last && same(last.value, next)) return last.value;
    last = { value: next };

    return next;
  };
}
