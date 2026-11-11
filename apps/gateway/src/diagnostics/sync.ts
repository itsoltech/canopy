import type { computerLink as link } from "@canopy/contracts";

/** One existing receiver, three scalar clocks. No cursor, frame or transcript is retained. */
export class MirrorDiagnostics {
  #detected: number | undefined;
  #confirmed = 0;
  #knownPending = false;
  constructor(
    readonly record: (metric: number, value: number) => void,
    readonly clock = () => performance.now(),
  ) {}

  received(update: link.MirrorUpdate) {
    if (update.heartbeat) return;
    this.#detected ??= this.clock();

    if (update.rangeBatch) this.record(204, 1);

    if (update.snapshotStart || (update.snapshot?.thread && !update.snapshotEnd)) this.record(203, 1);

    if (update.deltaStart) this.record(204, 1);

    // Unknown head/epoch is not a zero backlog. Only an explicit same-epoch cursor gives a count.
    if (update.commit && update.previousCursor) {
      const previous = /^([^:]+):(\d+)$/.exec(update.previousCursor);
      const next = /^([^:]+):(\d+)$/.exec(update.cursor);

      if (previous && next && previous[1] === next[1]) {
        this.#knownPending = true;
        this.record(
          201,
          Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(BigInt(next[2]!) - BigInt(previous[2]!)))),
        );
      }
    }
  }

  committed() {
    const now = this.clock();

    if (this.#detected !== undefined) this.record(200, now - this.#detected);
    this.#detected = undefined;
    this.#confirmed = now;

    if (this.#knownPending) this.record(201, 0);
    this.#knownPending = false;
  }

  confirmed() {
    this.#confirmed = this.clock();
  }
  heartbeat() {
    this.sample();
    this.confirmed();
  }
  sample() {
    if (this.#confirmed) this.record(202, this.clock() - this.#confirmed);
  }
}
