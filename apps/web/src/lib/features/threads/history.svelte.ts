import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { prependThreadPage } from "@canopy/domain/history-pages";
import { liveSource } from "#lib/shared/live-source.ts";
import { decode } from "#lib/shared/wire.ts";
import { bodyJson } from "#lib/shared/json.ts";
import { saveHistory } from "../desktop/history.ts";
import type { ThreadState } from "./thread-state.svelte.ts";

export class ThreadHistory {
  loading = $state(false);
  error = $state("");
  #restart = () => {};
  #abort = new AbortController();
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
          })}`,
        ondrop: () => {
          this.view.connection = "reconnecting";
        },
        onfailure: () => {
          this.view.failure = "Lost the connection to the gateway. Reconnecting…";
        },
        onmessage: (data) => {
          const update = decode(ui.ThreadUpdateSchema, JSON.parse(data));

          try {
            this.view.apply(update);
          } catch {
            this.reset();
            throw new Error("Thread resynchronization required");
          }

          const snapshot = this.read();

          if (snapshot?.thread) saveHistory(ui.ThreadSnapshotSchema, `thread_${id}`, snapshot);
          this.view.connection = update.syncing ? "syncing" : "live";
          this.view.failure = undefined;
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
    const base = this.read();

    if (this.loading || !base?.thread || (!target && !base.historyHasMore)) return;
    this.loading = true;
    this.error = "";
    const checkpoint = base.cursor;
    const signal = this.#abort.signal;

    try {
      const query = new URLSearchParams({ before: base.historyBeforeTurnId, version: base.historyVersion, target });
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
