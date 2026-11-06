import { Code, ConnectError } from "@connectrpc/connect";

const FAILURE_WINDOW_MS = 30_000;
const RESUME_GRACE_MS = 30_000;
const TIMER_GAP_MS = 15_000;

type ProcessHealth = { ready: boolean; failedSince?: number };

/** Liveness only. A new process must answer once before a health check may restart it. */
export class HealthChecks {
  private processes = new Map<string, ProcessHealth>();
  private epoch = 0;
  private paused = false;
  private graceUntil = 0;
  private lastPoll: number | undefined;

  constructor(
    private readonly log: (name: string, message: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  started(name: string) {
    this.processes.set(name, { ready: false });
  }

  reset() {
    this.epoch++;
    this.processes.clear();
  }

  suspend() {
    this.paused = true;
    this.epoch++;
  }

  resume() {
    this.paused = false;
    this.epoch++;
    this.graceUntil = this.now() + RESUME_GRACE_MS;
    this.lastPoll = this.now();

    for (const health of this.processes.values()) delete health.failedSince;
  }

  poll() {
    const now = this.now();

    // Sleep can stop the controller before Electron delivers suspend/resume.
    if (this.lastPoll !== undefined && now - this.lastPoll > TIMER_GAP_MS) this.resume();
    this.lastPoll = now;

    return !this.paused && now >= this.graceUntil;
  }

  async check(
    name: string,
    probe: () => Promise<void>,
    restart: (current: () => boolean) => Promise<void>,
  ): Promise<boolean> {
    const health = this.processes.get(name);
    const epoch = this.epoch;
    const started = this.now();

    if (!health || this.paused || started < this.graceUntil) return false;
    let reason: string | undefined;

    try {
      await probe();
    } catch (cause) {
      reason = healthFailure(cause);
    }

    if (this.now() - started > TIMER_GAP_MS) this.resume();

    if (epoch !== this.epoch || this.processes.get(name) !== health) return false;

    if (!reason) {
      health.ready = true;
      delete health.failedSince;

      return true;
    }

    this.log(name, `Liveness check failed: ${reason}${health.ready ? "" : "; waiting for startup"}`);

    if (!health.ready) return false;
    health.failedSince ??= this.now();
    const elapsed = this.now() - health.failedSince;

    if (elapsed >= FAILURE_WINDOW_MS) {
      this.log(name, `Liveness failed for ${elapsed}ms (${reason}); preparing owned process restart`);
      // The departure announcement can yield to a resume or a spontaneous process replacement.
      // Both invalidate this restart decision, including while its preparation is in flight.
      health.ready = false;
      delete health.failedSince;
      await restart(() => epoch === this.epoch && this.processes.get(name) === health);
    }

    return false;
  }
}

function healthFailure(cause: unknown): string {
  if (cause instanceof ConnectError)
    return cause.code === Code.DeadlineExceeded ? "timeout" : `gRPC ${Code[cause.code]}`;

  if (cause instanceof Error && ["TimeoutError", "AbortError"].includes(cause.name)) return "timeout";

  return cause instanceof Error ? cause.message : "probe failed";
}
