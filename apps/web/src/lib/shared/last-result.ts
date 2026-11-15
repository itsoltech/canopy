/**
 * Recomputes only when an input changes identity; otherwise returns the same result. For state that outlives the
 * component which created it: a `$derived` belongs to the effect active at its creation and keeps returning its
 * last value once that effect is destroyed (`derived_inert`). A getter over `$state` that calls this stays live in
 * any reader and keeps a stable result for unchanged inputs.
 */
export function lastResult<A extends readonly unknown[], R>(compute: (...args: A) => R): (...args: A) => R {
  let last: { args: A; value: R } | undefined;

  return (...args) => {
    if (last && args.every((arg, index) => arg === last!.args[index])) return last.value;
    const value = compute(...args);
    last = { args, value };

    return value;
  };
}
