import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

// Prime stride avoids aliasing alternating reserve/execute and wait/execution events.
export const TRACE_LIMITS = { samples: 10_000, bytes: 4 * 1024 * 1024, perSecond: 100, stride: 101 } as const;
export const LEGACY_TRACE_SAMPLES = 2000;
export const TRACE_OPERATIONS = ["rpc", "database", "pool", "ingest", "governor"] as const;

export type TraceOperation = (typeof TRACE_OPERATIONS)[number];

const FIELDS = 9;

/** Opt-in numeric ring. Inactive collection allocates nothing; no request/error/query can enter it.
 * 704 KiB plus a fixed 16-byte random scratch buffer, below the separate opt-in 4 MiB ceiling.
 * Export DTOs are built only by an explicit owner action and never cached.
 */
export class DiagnosticsTrace {
  #values: Float64Array | undefined;
  #random: Uint32Array<ArrayBuffer> | undefined;
  #lease = "";
  #process = "";
  #expires = 0;
  #deadline = 0;
  #clearAt = 0;
  #seen = 0;
  #head = 0;
  #size = 0;
  #second = -1;
  #rate = 0;
  #dropped = 0n;
  constructor(
    readonly monotonic = () => performance.now(),
    readonly utc = () => Date.now(),
  ) {}

  start(lease: string, process: string, minutes: number) {
    if (this.active || ![1, 5, 10].includes(minutes) || !/^[a-f0-9-]{36}$/.test(lease)) return false;
    this.clear();
    this.#values = new Float64Array(TRACE_LIMITS.samples * FIELDS);
    this.#random = new Uint32Array(4);
    this.#lease = lease;
    this.#process = process;
    this.#expires = this.utc() + minutes * 60_000;
    this.#deadline = this.monotonic() + minutes * 60_000;
    this.#clearAt = this.#deadline + 600_000;

    return true;
  }

  get active() {
    if (!this.#clearAt) return false;
    const now = this.monotonic();

    if (now >= this.#clearAt) {
      this.clear();

      return false;
    }

    return this.#deadline > now;
  }

  state() {
    const active = this.active;

    return create(ui.DiagnosticsTraceStateSchema, {
      active,
      expiresAtMs: BigInt(this.#expires),
      leaseId: this.#lease,
      processId: this.#process,
    });
  }

  stop(lease: string) {
    if (!lease || lease !== this.#lease) return false;
    this.#deadline = 0;
    this.#clearAt = Math.min(this.#clearAt, this.monotonic() + 600_000);

    return true;
  }

  record(operation: TraceOperation, id: number, duration: number, failed = false) {
    if (!this.#deadline || ++this.#seen % TRACE_LIMITS.stride) return;

    if (!Number.isSafeInteger(id) || id < 0 || !Number.isFinite(duration) || duration < 0) return;
    const now = this.monotonic();

    if (now >= this.#deadline) return;
    const second = Math.floor(now / 1000);

    if (second !== this.#second) {
      this.#second = second;
      this.#rate = 0;
    }

    if (this.#rate++ >= TRACE_LIMITS.perSecond) {
      this.#dropped++;

      return;
    }

    const at = this.#head * FIELDS;
    const values = this.#values!;
    values[at] = TRACE_OPERATIONS.indexOf(operation);
    values[at + 1] = id;
    values[at + 2] = duration;
    values[at + 3] = this.utc();
    values[at + 4] = failed ? 1 : 0;
    crypto.getRandomValues(this.#random!);
    values.set(this.#random!, at + 5);
    this.#head = (this.#head + 1) % TRACE_LIMITS.samples;

    if (this.#size === TRACE_LIMITS.samples) this.#dropped++;
    else this.#size++;
  }

  export(lease: string, maxSamples: number = TRACE_LIMITS.samples) {
    const state = this.state();

    if (!lease || lease !== state.leaseId) return;
    const spans: ui.DiagnosticsTraceSpan[] = [];
    const size = Math.min(this.#size, TRACE_LIMITS.samples, Math.max(0, Math.floor(maxSamples)));

    for (let i = 0; i < size; i++) {
      const at = ((this.#head - size + i + TRACE_LIMITS.samples) % TRACE_LIMITS.samples) * FIELDS;
      const value = this.#values!;
      let traceId = "";

      for (let offset = 5; offset < 9; offset++) traceId += value[at + offset]!.toString(16).padStart(8, "0");
      spans.push(
        create(ui.DiagnosticsTraceSpanSchema, {
          traceId,
          operation: TRACE_OPERATIONS[value[at]!]!,
          operationId: value[at + 1]!,
          durationMs: value[at + 2]!,
          sampledAtMs: BigInt(Math.floor(value[at + 3]!)),
          failed: value[at + 4] === 1,
        }),
      );
    }

    return create(ui.DiagnosticsTraceExportSchema, {
      state,
      spans,
      droppedSamples: this.#dropped + BigInt(this.#size - size),
    });
  }

  clear() {
    this.#values = undefined;
    this.#random = undefined;
    this.#lease = this.#process = "";
    this.#expires = this.#deadline = this.#clearAt = this.#seen = this.#head = this.#size = this.#rate = 0;
    this.#second = -1;
    this.#dropped = 0n;
  }
}

/** Stable identity derived solely from registered descriptors, never a request label. */
export function diagnosticMethodId(name: string) {
  let hash = 2166136261;

  for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);

  return hash >>> 0;
}

/** Only closed metadata fields may appear in ordinary local/remote snapshots. */
export function traceState(value: ui.DiagnosticsTraceState | undefined) {
  if (
    !value ||
    !/^[a-f0-9-]{36}$/.test(value.leaseId) ||
    !(value.processId === "gateway" || /^worker:[a-f0-9-]{36}$/.test(value.processId)) ||
    value.expiresAtMs <= 0n ||
    value.expiresAtMs > 8_640_000_000_000_000n
  )
    return;

  return create(ui.DiagnosticsTraceStateSchema, {
    // The home enforces its monotonic deadline; the observer's wall clock may differ.
    active: value.active,
    expiresAtMs: value.expiresAtMs,
    leaseId: value.leaseId,
    processId: value.processId,
  });
}
