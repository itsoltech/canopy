import type { ui } from "@canopy/contracts";
import type { WorkerRecords } from "#lib/features/workers/worker-records.svelte.ts";

/** One worker, bot or computer an access picker can grant access to. */
export interface AccessOption {
  readonly id: string;
  readonly name: string;
  /** Muted text on the right (a host); `online` replaces it with a status. */
  readonly detail?: string | undefined;
  /** Heading of consecutive options (the computer of linked workers); shown when there is more than one. */
  readonly group?: string | undefined;
  readonly online?: boolean | undefined;
  /** Why it cannot be changed here; the option stays as it is. */
  readonly readOnly?: string | undefined;
}

/** Workers grouped by computer, with their connection and whether this computer may change them. */
export function workerAccessOptions(records: WorkerRecords, workers: readonly ui.Worker[] = records.workers) {
  return workers.map((worker): AccessOption => ({
    id: worker.id,
    name: worker.name,
    group: records.name(worker),
    online: worker.online,
    readOnly: records.readOnly(worker.id) || undefined,
  }));
}
