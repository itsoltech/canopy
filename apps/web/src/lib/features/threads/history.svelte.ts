import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { mergeThreadHistoryPage } from "@canopy/domain/history-pages";
import { liveSource } from "#lib/shared/live-source.ts";
import { decode } from "#lib/shared/wire.ts";
import { bodyJson } from "#lib/shared/json.ts";
import { saveThreadHistory } from "../desktop/history.ts";
import type { ThreadState } from "./thread-state.svelte.ts";
import { clientMeasurements, clientOpening, timelineRecovery } from "#lib/features/diagnostics/client.ts";
import { recordThreadWatchFailure } from "@canopy/domain/diagnostics";
import { tick } from "svelte";
import { ThreadWatchRecovery, threadWatchMessage, threadSyncStatus } from "@canopy/domain/thread-watch-recovery";
import { threadWatchReady } from "@canopy/domain/thread-watch-state";
import { threadOverviewHead, warmCacheHit } from "./warming.ts";
import { ThreadWatchLiveness, threadViewDiverged } from "@canopy/domain/thread-watch-liveness";

export class ThreadHistory {
  loading = $state(false);
  error = $state("");
  #restart = () => {};
  #abort = new AbortController();
  #recovery = new ThreadWatchRecovery();
  #smaller = false;
  #reportedGap = false;
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

  /** `overviewStatus`: the thread's status from a live overview, a second witness of a stalled watch. */
  connect(id: string, overviewStatus: () => string | undefined = () => undefined) {
    const current = warmCacheHit(id, this.read());
    const opening = clientOpening(Boolean(this.read()?.thread), current);

    if (current) opening?.current();

    if (this.read()?.thread) opening?.paint();
    let first = true;
    this.#abort = new AbortController();
    let stop = () => {};

    const open = () => {
      stop();
      this.view.connection = this.read()?.thread ? "syncing" : "connecting";
      stop = liveSource(`/api/threads/${id}/events`, {
        stableMs: 10_000,
        onopen: (_, signal) => {
          // Admissions and completions belong to this live watch and cannot be replayed from a cursor.
          signal.addEventListener("abort", () => this.view.previewActivity.clear(), { once: true });
        },
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
          const scoped =
            failure.code === 14 && this.view.syncStatus?.reason === "computer_unreachable"
              ? { ...failure, computer: true }
              : failure;

          const decision = this.#recovery.failed(scoped);
          recordThreadWatchFailure(clientMeasurements, scoped, decision.reason);

          if (decision.action === "reset" || decision.action === "smaller") this.reset();

          if (decision.action === "smaller") this.#smaller = true;
          this.view.failure = threadWatchMessage(decision.reason);
          this.view.connection = decision.action === "stop" ? "error" : "reconnecting";
          console.warn("Thread watch failed", { code: failure.code, reason: decision.reason, action: decision.action });

          return decision.action !== "stop";
        },
        onmessage: (data) => {
          const started = first && opening ? performance.now() : 0;
          const update = decode(ui.ThreadUpdateSchema, JSON.parse(data));
          const previous = this.read();
          this.view.apply(update);

          const snapshot = this.read();

          if (first && (update.change.case === "snapshot" || update.change.case === "batch")) {
            first = false;

            if (started) opening?.snapshot(started);
            opening?.paint();
          }

          if (snapshot?.cursor && snapshot !== previous) saveThreadHistory(snapshot);
          this.view.syncStatus = update.syncStatus ?? this.view.syncStatus;

          if (update.change.case === "batch") this.view.syncStatus = threadSyncStatus(update.change.value);

          if (update.syncStatus?.reason) {
            this.view.connection = "error";
            this.view.failure = threadWatchMessage(update.syncStatus.reason, update.syncStatus.computerName);
          } else if (threadWatchReady(update) === true) {
            opening?.current();
            this.view.connection = "live";
            this.view.failure = undefined;

            if (update.change.case !== "batch") this.view.syncStatus = undefined;
            this.#recovery.advanced(snapshot?.syncCursor?.appliedSeq ?? 0n);
          } else if (!this.view.failure && threadWatchReady(update) === false) this.view.connection = "syncing";
        },
      });
    };

    this.#restart = open;
    open();
    const liveness = new ThreadWatchLiveness();

    const timer = setInterval(() => {
      if (document.hidden || !navigator.onLine || this.view.connection === "error") {
        liveness.pause();

        return;
      }

      const diverged = this.view.loaded && threadViewDiverged(overviewStatus(), this.view.running);
      const repair = liveness.check(this.read()?.syncCursor, threadOverviewHead(id), Date.now(), diverged);

      if (!repair) return;
      timelineRecovery("stalled_watch");
      console.warn(repair.reload ? "Thread watch reloaded" : "Thread watch resumed from applied cursor", {
        reason: "stalled_watch",
        ...repair,
      });

      if (repair.reload) this.reset();
      open();
    }, 1000);

    return () => {
      clearInterval(timer);
      opening?.cancel();
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
    const started = performance.now();

    if (!this.#reportedGap && base.historyItemsHasMore) {
      this.#reportedGap = true;
      timelineRecovery("history_window");
    }

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

      if (
        page.historyBeforeTurnId === base.historyBeforeTurnId &&
        page.historyBeforeItemId === base.historyBeforeItemId &&
        (page.historyHasMore || page.historyItemsHasMore) &&
        !page.historyReset
      )
        throw new Error("History page did not advance");

      let merged: ReturnType<typeof mergeThreadHistoryPage>;

      try {
        merged = mergeThreadHistoryPage(base, current, page);
      } catch {
        this.reset();
        this.#restart();

        return;
      }

      if (merged.snapshot === current) return;
      this.view.apply(create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: merged.snapshot } }));

      if (merged.resume) this.#restart();
      await tick();
      requestAnimationFrame(() => {
        if (!signal.aborted && !document.hidden) clientMeasurements.record(17, performance.now() - started);
      });
    } catch {
      if (!signal.aborted) this.error = "Could not load earlier messages. Try again.";
    } finally {
      this.loading = false;
    }
  }
}
