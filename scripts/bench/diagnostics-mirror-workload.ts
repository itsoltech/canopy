import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import type { GatewayCore } from "../../apps/gateway/src/core/core.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { ThreadMirror } from "../../apps/gateway/src/computers/mirror.ts";
import { MirrorDiagnostics } from "../../apps/gateway/src/diagnostics/sync.ts";

/** Exercise the actual receiver/atomic DB commit, with local frames instead of another measured host. */
export class DiagnosticsMirrorWorkload {
  readonly node = "a".repeat(64);
  readonly store: ComputerStore;
  readonly mirror: ThreadMirror;
  #abort: AbortController | undefined;
  #pending: Promise<void> | undefined;
  commits = 0;

  constructor(readonly core: GatewayCore) {
    this.store = new ComputerStore(core.diagnostics.options.runtime, core.diagnostics.options.userId, Buffer.alloc(32));
    this.mirror = new ThreadMirror(this.store, () =>
      core.diagnostics.options.workerDiagnosticsEnabled
        ? new MirrorDiagnostics((id, value) => core.diagnostics.sync(this.node, id, value))
        : undefined,
    );
  }

  async start() {
    await this.store.query(
      `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
      VALUES($1::uuid,$2,'Benchmark mirror','fixture','fixture') ON CONFLICT DO NOTHING`,
      [this.store.owner, this.node],
    );
  }

  begin(phase: string) {
    if (phase === "idle") return;
    const controller = new AbortController();
    this.#abort = controller;
    this.core.diagnostics.syncWatch(this.node, 3);
    this.#pending = this.mirror
      .consume(
        this.node,
        this.#frames(controller.signal),
        () => {
          this.commits++;
        },
        controller.signal,
      )
      .finally(() => this.core.diagnostics.syncWatch(this.node, -3));
    // The original promise is still awaited by end(); avoid an unhandled rejection before phase end.
    void this.#pending.catch(() => {});
  }

  async *#frames(signal: AbortSignal) {
    const epoch = crypto.randomUUID();
    const thread = crypto.randomUUID();
    let revision = 0;
    let previous = "";
    yield create(link.MirrorUpdateSchema, { reset: true });
    yield create(link.MirrorUpdateSchema, { snapshot: { thread: { id: thread, title: "Synthetic mirror" } } });
    yield create(link.MirrorUpdateSchema, { commit: true, cursor: `${epoch}:${++revision}` });
    previous = `${epoch}:${revision}`;

    while (!signal.aborted) {
      await Bun.sleep(1000);

      if (signal.aborted) return;
      yield create(link.MirrorUpdateSchema, {
        previousCursor: previous,
        deltaStart: true,
        delta: { baseCursor: previous, snapshot: { thread: { id: thread, title: `Synthetic mirror ${revision}` } } },
      });
      yield create(link.MirrorUpdateSchema, { previousCursor: previous, deltaEnd: true });
      yield create(link.MirrorUpdateSchema, {
        previousCursor: previous,
        commit: true,
        cursor: `${epoch}:${++revision}`,
      });
      previous = `${epoch}:${revision}`;
      // Three existing watches, one revision refresh per watch; no watch IDs are retained.
      this.core.diagnostics.sync(this.node, 210, 3);
      this.core.diagnostics.sync(this.node, 221, 3);
    }
  }

  async end() {
    this.#abort?.abort();
    await this.#pending;
    this.#pending = undefined;
  }
}
