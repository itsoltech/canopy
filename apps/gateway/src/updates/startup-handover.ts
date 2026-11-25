import { setTimeout } from "node:timers/promises";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { onSupervisorHandover, type UpdateRecord } from "@canopy/updater";

/** A candidate proves its listeners before it takes work from clients or workers. */
export class GatewayStartupHandover {
  readonly #requested = Promise.withResolvers<boolean>();
  #pending: boolean;

  constructor(record: UpdateRecord | undefined, late: () => Promise<void>, log: (message: string) => void) {
    const supervisorVersion = process.env["CANOPY_SUPERVISOR_VERSION"];
    // Earlier supervisors support the same IPC without advertising their version.
    this.#pending =
      process.connected &&
      (supervisorVersion === undefined
        ? record?.version === CANOPY_VERSION && record.previousVersion !== CANOPY_VERSION && record.state !== "failed"
        : !!supervisorVersion && supervisorVersion !== CANOPY_VERSION);

    onSupervisorHandover(async () => {
      if (!this.#pending) return late();
      this.#requested.resolve(true);
    }, log);
  }

  readonly intercept: Interceptor = (next) => (request) => {
    if (this.#pending) throw new ConnectError("Gateway update control is starting", Code.Unavailable);

    return next(request);
  };

  async wait(): Promise<boolean> {
    if (!this.#pending) return false;
    const timeout = new AbortController();

    try {
      // The supervisor sends on startup confirmation and retries on its 250 ms poll.
      const requested = await Promise.race([
        this.#requested.promise,
        setTimeout(1000, false, { signal: timeout.signal }),
      ]);

      this.#pending = requested;

      return requested;
    } finally {
      timeout.abort();
    }
  }
}
