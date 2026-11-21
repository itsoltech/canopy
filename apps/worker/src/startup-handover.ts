import { setTimeout } from "node:timers/promises";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { confirmStartup, onSupervisorHandover, readUpdateRecord } from "@canopy/updater";
import type { WorkerUpdates } from "./update-link.ts";

/** Allow the supervisor to finish an update after Welcome and before the host starts serving the link. */
export class BinaryWorkerStartup {
  readonly #handover = Promise.withResolvers<{ finished: Promise<void> }>();
  #ready = false;

  constructor(
    readonly updates: WorkerUpdates,
    log: (message: string) => void,
  ) {
    onSupervisorHandover(() => {
      const finished = updates.handover();
      this.#handover.resolve({ finished });

      return finished;
    }, log);
  }

  async confirm(stopping: AbortSignal): Promise<void> {
    if (this.#ready) return;
    const supervisorVersion = process.env["CANOPY_SUPERVISOR_VERSION"];
    // Earlier supervisors know the handover IPC but do not advertise their version.
    const record = process.connected && supervisorVersion === undefined ? await readUpdateRecord() : undefined;

    const mayHandOver =
      process.connected &&
      (supervisorVersion === undefined
        ? record?.version === CANOPY_VERSION && record.previousVersion !== CANOPY_VERSION && record.state !== "failed"
        : !!supervisorVersion && supervisorVersion !== CANOPY_VERSION);

    await confirmStartup();

    if (!mayHandOver || stopping.aborted) return;
    const timeout = new AbortController();

    try {
      // The supervisor requests handover on confirmation and retries on its 250 ms poll. Fall through for old
      // supervisors without IPC handover and when handover is unavailable.
      const request = await Promise.race([
        this.#handover.promise,
        setTimeout(1_000, undefined, { signal: AbortSignal.any([stopping, timeout.signal]) }).catch(() => undefined),
      ]);

      await request?.finished;
    } finally {
      timeout.abort();
    }
  }

  ready(): void {
    if (this.#ready) return;
    this.#ready = true;
    this.updates.startupReady();
  }
}
