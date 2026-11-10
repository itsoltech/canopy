import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { RpcCollector } from "./collector.ts";
import type { DiagnosticsStore, StoredMinute } from "./store.ts";
import { encodeRollup } from "./rollup.ts";

const PENDING_BYTES = 4 * 1024 * 1024;

export class DiagnosticsPersistence {
  restoring = true;
  status = "restoring";
  persistedThrough = 0;
  epoch: string = crypto.randomUUID();
  readonly pending = new Map<number, { minute: StoredMinute; bytes: number }>();
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
    },
  ) {
    this.#historyAfter = collector.startedAt - 86_400_000 - 1;
    this.#queuedThrough = Math.floor(collector.startedAt / 60_000) * 60_000 - 60_000;
  }

  start() {
    this.#restore ??= this.#load();

    return this.#restore;
  }

  async #load() {
    try {
      const state = await this.store.state();

      if (!this.#stateLoaded && state?.schemaVersion === 1) {
        this.epoch = state.epoch;
        this.persistedThrough = Number(state.persistedThroughMs);
        this.#lost = state.persistenceGap;
        this.host.restore(state);
      }

      this.#stateLoaded = true;

      for await (const { at, rollup } of this.store.history(this.#historyAfter + 1)) {
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
        const bytes = encodeRollup(processes).length;
        this.#pendingBytes += bytes - (this.pending.get(at)?.bytes ?? 0);
        this.pending.set(at, { minute: { at, processes }, bytes });
      } catch {
        this.#lost = true;
      }

      this.#queuedThrough = at;
    }

    while (this.#pendingBytes > PENDING_BYTES && this.pending.size) {
      const first = this.pending.keys().next().value;

      if (first === undefined) break;
      this.#pendingBytes -= this.pending.get(first)!.bytes;
      this.pending.delete(first);
      this.#lost = true;
    }

    if (!this.pending.size) return;
    const minutes = [...this.pending.values()].map((entry) => entry.minute);
    const next = this.#state();
    const watermarks = new Map<string, ui.DiagnosticsProcess>();

    for (const minute of minutes)
      for (const process of minute.processes)
        for (const checkpoint of process.checkpoints)
          watermarks.set(
            `${process.processId}:${checkpoint.session}`,
            create(ui.DiagnosticsProcessSchema, {
              processId: process.processId,
              session: checkpoint.session,
              sequence: checkpoint.sequence,
            }),
          );
    next.watermarks = [...watermarks.values()];
    next.persistedThroughMs = minutes
      .flatMap((minute) => minute.processes.flatMap((process) => process.coverage))
      .reduce((latest, range) => (range.endMs > latest ? range.endMs : latest), BigInt(this.persistedThrough));

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

      await this.store.write(minutes, next);
      this.host.saved?.(next);
      this.persistedThrough = Number(next.persistedThroughMs);
      this.pending.clear();
      this.#pendingBytes = 0;
      this.status = this.#lost ? "persistence_gap" : "saved";
    } catch {
      this.status = "unavailable";
    }
  }

  async stop() {
    await this.#running;
    await this.flush(true);
  }
}
