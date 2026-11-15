import { create, toBinary } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { ThreadCache } from "@canopy/domain/thread-cache";
import { threadCacheTail } from "@canopy/domain/thread-cache-tail";
import { ThreadWarmer } from "@canopy/domain/thread-warmer";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { THREAD_WARM_LIMITS } from "@canopy/domain/thread-warm-set";

/** One bounded cache and background queue for the BFF, shared by every renderer window. */
export class BffWarming {
  readonly cache = new ThreadCache({ count: 32, bytes: 16 * 1024 * 1024 });
  readonly warmer: ThreadWarmer;
  #closed = false;
  #authorizedIds: Set<string> | undefined;
  generation = 0;

  constructor(
    readonly api: Client<typeof ui.GatewayService>,
    readonly changed: (id: string, update: ui.ThreadUpdate) => void,
  ) {
    this.warmer = new ThreadWarmer(
      {
        peek: (id) => this.cache.peek(id),
        load: async (id) => this.cache.get(id),
        save: (snapshot) => {
          if (!this.#closed) this.cache.set(threadCacheTail(snapshot));
        },
      },
      async function* (id, syncCursor, signal) {
        for await (const update of api.watchThread(
          { threadId: id, syncCursor, sequence: true, background: true, pageSize: 24 },
          { signal, timeoutMs: 7000 },
        )) {
          if (signal.aborted) return;
          changed(id, update);
          yield update;
        }
      },
      { ...THREAD_WARM_LIMITS, requested: () => {} },
    );
  }

  select(ids: readonly string[]) {
    this.warmer.select(ids);
    this.warmer.enable(ids.length > 0);
  }

  apply(update: ui.OverviewUpdate) {
    const change = update.change;

    if (change.case === "threadHeads") this.warmer.heads(change.value.heads);

    if (change.case === "mobileSnapshot") {
      const next = new Set(change.value.threads.map((thread) => thread.id));
      const removed = this.#authorizedIds && [...this.#authorizedIds].some((id) => !next.has(id));

      this.#authorizedIds = next;

      if (removed) this.#reset();
    }

    if (change.case === "thread") {
      if (change.value.deletedAt) {
        this.#authorizedIds?.delete(change.value.id);
        this.#reset();
      } else (this.#authorizedIds ??= new Set()).add(change.value.id);
    }

    // Sharing changes may revoke private history without changing a thread's checkpoint.
    if (["computerSnapshot", "computerRemoved"].includes(change.case ?? "")) {
      this.#authorizedIds = undefined;
      this.#reset();
    }
  }

  #reset() {
    this.generation++;
    this.warmer.reset();
    this.cache.clear();
  }

  /** A visible watch updates the same bounded tail; it never replaces the renderer's loaded history. */
  observe(id: string, update: ui.ThreadUpdate, generation = this.generation) {
    if (this.#closed) return;
    this.changed(id, update);

    if (generation !== this.generation) return;

    try {
      const current = this.cache.peek(id);

      if (!current && update.change.case !== "snapshot") return;
      const next = applyThreadUpdate(current, update);

      if (next.thread?.id === id) this.cache.set(threadCacheTail(next));
    } catch {
      this.cache.delete(id);
    }
  }

  seed(id: string): ui.ThreadUpdate | undefined {
    const snapshot = this.cache.get(id);

    if (!snapshot) return undefined;

    // Warm windows have a separate byte budget from renderer history and must fit one stream frame.
    if (toBinary(ui.ThreadSnapshotSchema, snapshot).byteLength > 600 * 1024) return undefined;

    return create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } });
  }

  close() {
    this.#closed = true;
    this.warmer.close();
    this.cache.clear();
    this.#authorizedIds = undefined;
  }
}
