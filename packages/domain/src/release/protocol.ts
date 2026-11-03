/** Increase only for a breaking WorkerLink contract; additive fields do not need a bump. */
export const WORKER_LINK_PROTOCOL = 1;
/** Protocol 0 (before negotiation) is deliberately incompatible. Recovery uses UpdateService. */
export const MIN_WORKER_LINK_PROTOCOL = 1;
/** Frozen openagents.update.v1; never bump this for WorkerLink or application releases. */
export const UPDATE_PROTOCOL = 1;

export function workerLinkCompatible(min: number, max: number): boolean {
  return Number.isInteger(min) && Number.isInteger(max) && min > 0 && max >= min &&
    max >= MIN_WORKER_LINK_PROTOCOL && min <= WORKER_LINK_PROTOCOL;
}
