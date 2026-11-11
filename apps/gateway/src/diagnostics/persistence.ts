import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { RpcCollector } from "./collector.ts";
import type { DiagnosticsStore, EncodedMinute } from "./store.ts";
import { encodeRollup } from "./rollup.ts";
import { PENDING_BYTES, PENDING_ENTRY_BYTES } from "./pending.ts";

export class DiagnosticsPersistence {
  restoring = true;
  status = "restoring";
  persistedThrough = 0;
  epoch: string = crypto.randomUUID();
  readonly pending = new Map<number, { minute: EncodedMinute; bytes: number }>();
  #running: Promise<void> | undefined;
  #restore: Promise<void> | undefined;
  #queuedThrough = 0;
  #pendingBytes = 0;
  #lost = false;
  #initialized = false;
  #historyLoaded = false;
  #stateLoaded = false;
  #historyAfter: number;

  constructor(
    readonly store: DiagnosticsStore,
    readonly collector: RpcCollector,
    readonly host: {
      state(): Pick<ui.DiagnosticsState, "findings" | "watermarks" | "peerOverviews">;
      restore(state: ui.DiagnosticsState): void;
      restoreProcess(process: ui.DiagnosticsProcess, at: number): void;
      processes(at: number): ui.DiagnosticsProcess[];
      saved?(state: ui.DiagnosticsState): void;
      ready?(): void;
    },
  ) {
    this.#historyAfter = collector.startedAt - 3_600_000 - 1;
    this.#queuedThrough = Math.floor(collector.startedAt / 60_000) * 60_000 - 60_000;
  }

  start() {
    this.#restore ??= this.#load();

    return this.#restore;
  }

  get ready() {
    return this.#stateLoaded;
  }

  get pendingBytes() {
    return this.#pendingBytes;
  }

  async #load() {
    // Yield until after the listener is ready. Public reads never await this background task.
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      const state = await this.store.state();

      if (!this.#stateLoaded && state?.schemaVersion === 1) {
        this.epoch = state.epoch;
        this.persistedThrough = Number(state.persistedThroughMs);
        this.#lost = state.persistenceGap;
        this.host.restore(state);
      }

      this.#stateLoaded = true;

      for await (const { at, rollup } of this.store.history(this.#historyAfter + 1, this.collector.startedAt)) {
        for (const process of rollup.processes) {
          if (process.processId === "gateway") this.collector.restore(process, at);
          else this.host.restoreProcess(process, at);
        }

        this.#historyAfter = at;
      }

      this.#historyLoaded = true;

      await this.store.initialize(this.#state());
      this.#initialized = true;
      this.status = "saved";
    } catch {
      this.status = "unavailable";
    } finally {
      this.restoring = false;

      if (this.#stateLoaded) this.host.ready?.();
    }
  }

  #state() {
    return create(ui.DiagnosticsStateSchema, {
      schemaVersion: 1,
      epoch: this.epoch,
      persistedThroughMs: BigInt(this.persistedThrough),
      ...this.host.state(),
      persistenceGap: this.#lost,
    });
  }

  flush(includeCurrent = false) {
    if (this.#running) return this.#running;
    this.#running = this.#flush(includeCurrent).finally(() => {
      this.#running = undefined;
    });

    return this.#running;
  }

  async #flush(includeCurrent: boolean) {
    await this.#restore;

    if (!this.#historyLoaded) await this.#load();
    this.collector.tick();
    const current = Math.floor(this.collector.clock.utc() / 60_000) * 60_000;

    for (
      let at = Math.max(this.#queuedThrough + 60_000, current - 3_540_000);
      at < current + Number(includeCurrent) * 60_000;
      at += 60_000
    ) {
      const own = this.collector.rollup(at);

      if (!own) continue;
      const processes = [own, ...this.host.processes(at)];

      try {
        const payload = encodeRollup(processes);
        // Charge the backing allocation and conservative object/Map overhead, not a smaller wire view.
        const bytes = payload.buffer.byteLength + PENDING_ENTRY_BYTES;
        this.#pendingBytes -= this.pending.get(at)?.bytes ?? 0;
        this.pending.delete(at);
        this.#trim(current, bytes, 1);
        this.#pendingBytes += bytes;
        this.pending.set(at, { minute: { at, payload }, bytes });
      } catch {
        this.#lost = true;
        this.collector.budget.dropped++;
      }

      this.#queuedThrough = at;
    }

    this.#trim(current);

    if (!this.pending.size) {
      if (this.#lost) this.status = "persistence_gap";

      return;
    }

    const minutes = [...this.pending.values()].map((entry) => entry.minute);
    const next = this.#state();

    if (
      toBinary(ui.DiagnosticsStateSchema, create(ui.DiagnosticsStateSchema, { ...next, peerOverviews: [] })).length >
      65536
    ) {
      this.status = "persistence_gap";

      return;
    }

    try {
      if (!this.#initialized) {
        await this.store.initialize(next);
        this.#initialized = true;
      }

      const saved = await this.store.write(minutes, next);
      this.host.saved?.(saved);
      this.persistedThrough = Number(saved.persistedThroughMs);
      this.pending.clear();
      this.#pendingBytes = 0;
      this.status = this.#lost ? "persistence_gap" : "saved";
    } catch {
      this.status = "unavailable";
    }
  }

  #trim(current: number, bytes = 0, slots = 0) {
    // Retry only within the live minute ring, and reserve space before retaining a new payload.
    while (this.pending.size) {
      const first = this.pending.keys().next().value!;

      if (
        this.pending.size + slots <= 60 &&
        this.#pendingBytes + bytes <= PENDING_BYTES &&
        first >= current - 3_540_000
      )
        break;
      this.#pendingBytes -= this.pending.get(first)!.bytes;
      this.pending.delete(first);
      this.#lost = true;
      this.collector.budget.dropped++;
    }
  }

  async stop() {
    await this.#running;
    await this.flush(true);
  }
}
