import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { liveSource } from "#lib/shared/live-source.ts";
import { decode } from "#lib/shared/wire.ts";
import { bodyJson } from "#lib/shared/json.ts";
import { saveHistory } from "../desktop/history.ts";
import type { ThreadState } from "./thread-state.svelte.ts";
import { ThreadWatchRecovery, threadWatchMessage, threadSyncStatus } from "@canopy/domain/thread-watch-recovery";

export class ThreadHistory {
  loading = $state(false);
  error = $state("");
  #restart = () => {};
  #abort = new AbortController();
  #recovery = new ThreadWatchRecovery();
  #smaller = false;
  retry() {
    this.#recovery.reset();
    this.#restart();
  }
  loadFromScratch() {
    this.reset();
    this.#smaller = false;
    this.retry();
  }
  constructor(
    readonly view: ThreadState,
    readonly read: () => ui.ThreadSnapshot | undefined,
    readonly reset: () => void,
  ) {}

  connect(id: string) {
    this.#abort = new AbortController();
    let stop = () => {};

    const open = () => {
      stop();
      this.view.connection = this.read()?.thread ? "syncing" : "connecting";
      stop = liveSource(`/api/threads/${id}/events`, {
        url: () =>
          `/api/threads/${id}/events?${new URLSearchParams({
            incremental: "1",
            cursor: this.read()?.cursor ?? "",
            from: this.read()?.historyBeforeTurnId ?? "",
            version: this.read()?.historyVersion ?? "",
            smaller: this.#smaller ? "1" : "0",
          })}`,
        ondrop: () => {
          if (!this.view.failure) this.view.connection = "reconnecting";
        },
        onfailure: () => {
          this.view.failure = threadWatchMessage("watch_failed");
          this.view.connection = "error";
        },
        onerror: (failure) => {
          const decision = this.#recovery.failed(failure);

          if (decision.action === "reset" || decision.action === "smaller") this.reset();

          if (decision.action === "smaller") this.#smaller = true;
          this.view.failure = threadWatchMessage(decision.reason);
          this.view.connection = "error";
          console.warn("Thread watch failed", { code: failure.code, reason: decision.reason, action: decision.action });

          return decision.action !== "stop";
        },
        onmessage: (data) => {
          const update = decode(ui.ThreadUpdateSchema, JSON.parse(data));

          try {
            this.view.apply(update);
          } catch {
            throw new Error("Thread resynchronization required");
          }

          const snapshot = this.read();

          if (snapshot?.thread && snapshot.cursor) saveHistory(ui.ThreadSnapshotSchema, `thread_${id}`, snapshot);
          this.view.syncStatus = update.syncStatus ?? this.view.syncStatus;

          if (update.change.case === "batch") this.view.syncStatus = threadSyncStatus(update.change.value);

          if (update.syncStatus?.reason) {
            this.view.connection = "error";
            this.view.failure = threadWatchMessage(update.syncStatus.reason, update.syncStatus.computerName);
          } else if (
            !update.syncing &&
            (update.change.case === "snapshot" || (update.change.case === "batch" && update.change.value.caughtUp))
          ) {
            this.view.connection = "live";
            this.view.failure = undefined;

            if (update.change.case !== "batch") this.view.syncStatus = undefined;
            this.#recovery.advanced(snapshot?.syncCursor?.appliedSeq ?? 0n);
          } else if (!this.view.failure && update.syncing) this.view.connection = "syncing";
        },
      });
    };

    this.#restart = open;
    open();

    return () => {
      stop();
      this.#abort.abort();
      this.#restart = () => {};
    };
  }

  async load(target = "") {
    // Revealing a quote walks bounded pages so the loaded window stays continuous.
    if (target) {
      while (!this.read()?.items.some((entry) => entry.item?.itemId === target)) {
        const before = this.read()?.historyBeforeItemId;

        if (this.loading || this.error || (!this.read()?.historyHasMore && !this.read()?.historyItemsHasMore)) return;
        await this.load();

        if (this.#abort.signal.aborted || this.read()?.historyBeforeItemId === before) return;
      }

      return;
    }

    const base = this.read();

    if (this.loading || !base?.thread || (!target && !base.historyHasMore && !base.historyItemsHasMore)) return;
    this.loading = true;
    this.error = "";
    const checkpoint = base.cursor;
    const signal = this.#abort.signal;

    try {
      const query = new URLSearchParams({
        before: base.historyBeforeTurnId,
        beforeItem: base.historyBeforeItemId,
        version: base.historyVersion,
        target,
      });

      const response = await fetch(`/api/threads/${base.thread.id}/history?${query}`, { signal });

      if (!response.ok) throw new Error("History unavailable");
      const page = decode(ui.ThreadSnapshotSchema, await bodyJson(response));
      const current = this.read();

      if (signal.aborted || !current) return;
      let next: ui.ThreadSnapshot;

      try {
        next = prependThreadPage(current, page, checkpoint);
      } catch {
        this.reset();
        this.#restart();

        return;
      }

      this.view.apply(create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: next } }));
      this.#restart();
    } catch {
      if (!signal.aborted) this.error = "Could not load earlier messages. Try again.";
    } finally {
      this.loading = false;
    }
  }
}
