import { getContext, setContext } from "svelte";
import type { ui } from "@canopy/contracts";
import { changeRewind, type RewindAction } from "./rewind-api.ts";

/** Operations survive transport failures: Retry reuses the intent or reads its durable result. */
export class ThreadRewind {
  busy = $state(false);
  error = $state("");
  canRetry = $state(false);
  draft = $state.raw<ui.Turn>();
  open = $state.raw<ReadonlySet<string>>(new Set());
  #retry: { threadId: string; action: RewindAction } | undefined;
  #composer: (() => boolean) | undefined;
  #generation = 0;

  connect(ready: () => boolean) {
    this.#composer = ready;

    return () => {
      if (this.#composer === ready) this.#composer = undefined;
    };
  }

  toggle(id: string) {
    const next = new Set(this.open);

    if (!next.delete(id)) next.add(id);
    this.open = next;
  }

  show(id: string) {
    this.open = new Set(this.open).add(id);
  }

  async edit(threadId: string, turnId: string, preview: ui.ThreadRewindPreview, restoreFiles: boolean) {
    if (!this.#composer?.()) {
      this.error = "Finish sending or uploading files before editing this message.";

      return false;
    }

    return this.run(threadId, {
      action: "rewind",
      turnId,
      restoreFiles,
      stopRunning: preview.running,
      clientRequestId: crypto.randomUUID(),
    });
  }

  async restore(threadId: string, rewindId: string) {
    return this.run(threadId, { action: "restore", rewindId });
  }

  async recover(threadId: string, rewindId: string) {
    return this.run(threadId, { action: "read", rewindId });
  }

  async retry() {
    if (this.#retry) await this.run(this.#retry.threadId, this.#retry.action);
  }

  dispose() {
    this.#generation++;
  }

  private async run(threadId: string, action: RewindAction): Promise<boolean> {
    if (this.busy) return false;
    const generation = ++this.#generation;
    this.busy = true;
    this.error = "";
    this.canRetry = true;
    this.#retry = { threadId, action };

    try {
      let result = await changeRewind(threadId, action);
      this.#retry = { threadId, action: { action: "read", rewindId: result.rewindId } };

      for (let attempt = 0; ["pending", "restoring"].includes(result.status) && attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (generation !== this.#generation) return false;
        result = await changeRewind(threadId, { action: "read", rewindId: result.rewindId });
      }

      if (generation !== this.#generation) return false;

      if (["pending", "restoring"].includes(result.status))
        throw new Error("The agent is still editing this thread. Retry to check its progress.");

      if (result.error || result.status === "failed") {
        this.#retry = undefined;
        this.canRetry = false;
        throw new Error(result.error || "Could not edit this thread. Choose the message again.");
      }

      if (result.status === "completed" && result.draft) this.draft = result.draft;
      this.#retry = undefined;
      this.canRetry = false;

      return true;
    } catch (cause) {
      if (generation === this.#generation)
        this.error = cause instanceof Error ? cause.message : "Could not reach the agent. Retry to check the result.";

      return false;
    } finally {
      if (generation === this.#generation) this.busy = false;
    }
  }
}

const KEY = Symbol("thread-rewind");
export const provideThreadRewind = (state: () => ThreadRewind) => setContext(KEY, state);
export const useThreadRewind = (): (() => ThreadRewind) | undefined => getContext(KEY);
