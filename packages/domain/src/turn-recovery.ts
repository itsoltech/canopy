export const WORKER_OOM_CONTINUATION =
  "Continue the previous task. The worker restarted because of memory pressure. Check which actions completed before repeating them. Use less parallelism for memory-intensive work.";

/** Both the manual retry and the automatic continuation preserve the last substantive request. */
export function isContinuationInput(text: string): boolean {
  return text === "Continue" || text === WORKER_OOM_CONTINUATION;
}
