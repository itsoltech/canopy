import { useEffect, useState } from "react";

/**
 * Follows `value` only once a new value has held for `ms`, so a value that flips and back within that time (a command
 * that ends a moment after it starts) never shows. The first value shows at once.
 */
export function useSettled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);

  useEffect(() => {
    if (Object.is(value, shown)) return;
    const timer = setTimeout(() => setShown(value), ms);

    return () => clearTimeout(timer);
  }, [value, shown, ms]);

  return shown;
}
