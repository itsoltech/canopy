/**
 * Runs `task` once the browser is idle (at the latest after `timeout` ms), for work that can wait until
 * the page answers input: a timer where there is no `requestIdleCallback` (Safari). Returns the cancel.
 */
export function whenIdle(task: () => void, timeout: number): () => void {
  if ("requestIdleCallback" in globalThis) {
    const id = requestIdleCallback(task, { timeout });

    return () => cancelIdleCallback(id);
  }

  const timer = setTimeout(task, Math.min(timeout, 1000));

  return () => clearTimeout(timer);
}
