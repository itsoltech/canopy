import { systemCheckClock, type CheckClock } from "@canopy/domain/update-checks";

export const updateTimeouts = { prepare: 60_000, check: 60_000, download: 30 * 60_000, stall: 90_000 };

export class UpdateResumed extends Error {}

/** Bounds even promises that ignore cancellation; the controller retires their updater before retrying. */
export class UpdateOperation {
  readonly abort = new AbortController();
  private touched: number;
  private transferred = 0;
  private cancelStall?: () => void;
  private timeout = 0;
  private deadline = 0;
  private finished = false;
  constructor(
    private readonly clock: CheckClock = systemCheckClock,
    private readonly limits = updateTimeouts,
  ) {
    this.touched = clock.now();
  }
  get signal() {
    return this.abort.signal;
  }
  get active() {
    return !this.finished && !this.signal.aborted;
  }
  close() {
    this.finished = true;
    this.cancelStall?.();
  }
  recover() {
    if (!this.active) return;

    if (this.clock.now() >= this.deadline || this.clock.now() - this.touched >= this.timeout)
      this.abort.abort(new UpdateResumed("Retrying after wake"));
  }
  progress(transferred: number) {
    if (!this.active || transferred <= this.transferred) return;
    this.transferred = transferred;
    this.touched = this.clock.now();
    this.watchStall();
  }
  private expire = () => {
    this.abort.abort(new Error("Update timed out. Check the connection, then retry."));
  };
  private watchStall() {
    this.cancelStall?.();
    this.cancelStall = this.clock.schedule(this.expire, this.limits.stall);
  }
  async wait<T>(stage: "prepare" | "check" | "download", run: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    this.timeout = stage === "download" ? this.limits.stall : this.limits[stage];
    this.touched = this.clock.now();
    this.deadline = this.touched + this.limits[stage];
    const cancel = this.clock.schedule(this.expire, this.limits[stage]);

    if (stage === "download") this.watchStall();
    const interrupted = Promise.withResolvers<never>();
    const stop = () => interrupted.reject(this.signal.reason);
    this.signal.addEventListener("abort", stop, { once: true });

    try {
      return await Promise.race([run(), interrupted.promise]);
    } finally {
      cancel();
      this.cancelStall?.();
      this.signal.removeEventListener("abort", stop);
    }
  }
}
