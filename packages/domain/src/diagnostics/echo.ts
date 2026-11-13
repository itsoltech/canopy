import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Histogram } from "./histogram.ts";

/** One outstanding echo, measured on the sender's monotonic clock. No response is never an RTT sample. */
export class HeartbeatEcho {
  readonly session = crypto.randomUUID();
  #sequence = 0n;
  #pending: { sequence: bigint; sent: number } | undefined;
  #previous: number | undefined;
  #rtt = new Histogram();
  #jitter = new Histogram();
  #timeouts = 0n;
  #batch = 0n;
  #started = Date.now();

  send(now = performance.now(), timeoutMs = 30_000) {
    if (this.#pending && now - this.#pending.sent < timeoutMs) return 0n;

    if (this.#pending) this.#timeouts++;
    const sequence = ++this.#sequence;
    this.#pending = { sequence, sent: now };

    return sequence;
  }

  receive(sequence: bigint, now = performance.now()) {
    if (!this.#pending || sequence !== this.#pending.sequence) return;
    const rtt = Math.max(0, now - this.#pending.sent);
    this.#pending = undefined;
    this.#rtt.record(rtt);

    if (this.#previous !== undefined) this.#jitter.record(Math.abs(rtt - this.#previous));
    this.#previous = rtt;

    return rtt;
  }

  batch(now = Date.now()) {
    const report = create(ui.WorkerLinkDiagnosticsSchema, {
      session: this.session,
      sequence: ++this.#batch,
      startMs: BigInt(this.#started),
      endMs: BigInt(now),
      rtt: this.#rtt.snapshot(),
      jitter: this.#jitter.snapshot(),
      echoTimeouts: this.#timeouts,
    });

    this.#started = now;
    this.#rtt = new Histogram();
    this.#jitter = new Histogram();
    this.#timeouts = 0n;

    return report;
  }
}
