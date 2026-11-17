import { AgentTool, type RunAgentTool, type AgentToolSessionDefaults } from "@canopy/contracts";
import type { AgentTools } from "../agent-tools/index.ts";
import { browserPreview } from "./browser.ts";
import { screenshotPreview } from "./screenshots.ts";
import { PreviewRuntime } from "./runtime.ts";
import { PreviewInputQueue } from "./input-queue.ts";
import { PreviewWatch, previewMetadata } from "./watch.ts";
import type { PreviewBackend, PreviewUpdate } from "./types.ts";

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Preview stopped"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );

    if (signal.aborted) abort();
  });
}

export class PreviewGroup {
  readonly watches = new Map<string, PreviewWatch>();
  readonly input: PreviewInputQueue;
  readonly #abort = new AbortController();
  readonly #ready: Promise<PreviewBackend>;
  #backend: PreviewBackend | undefined;
  #starting: Promise<void> | undefined;
  #metadata: PreviewUpdate = { state: "connecting" };
  #frame: PreviewUpdate | undefined;
  #closed: Promise<void> | undefined;

  constructor(
    tools: AgentTools,
    scope: RunAgentTool,
    fail: (detail: string) => void,
    defaults?: AgentToolSessionDefaults,
  ) {
    this.#ready = this.#open(tools, scope, fail, defaults);
    void this.#ready.catch((error) => {
      if (!this.#abort.signal.aborted) fail(error instanceof Error ? error.message : "Preview could not start");
    });
    this.input = new PreviewInputQueue(
      () => this.#ready,
      (owner, error) => {
        this.watches.get(owner)?.offer({ ...this.#metadata, state: "ready", detail: error.message.slice(0, 4096) });
      },
    );
  }

  async #open(
    tools: AgentTools,
    scope: RunAgentTool,
    fail: (detail: string) => void,
    defaults?: AgentToolSessionDefaults,
  ): Promise<PreviewBackend> {
    const signal = this.#abort.signal;
    const resolved = await cancellable(tools.resolvePreviewScope(scope, defaults), signal);
    signal.throwIfAborted();
    const runtime = new PreviewRuntime(resolved, signal);

    const context = {
      runtime,
      signal,
      emit: (update: PreviewUpdate) => {
        if (signal.aborted) return;
        const bounded = previewMetadata(update);
        const targetChanged = bounded.targetId !== undefined && bounded.targetId !== this.#metadata.targetId;

        if (targetChanged || (scope.tool !== AgentTool.BROWSER && !bounded.targetId)) this.#frame = undefined;

        if (bounded.state === "error" || bounded.state === "closed") this.#frame = undefined;
        else if (
          bounded.state === "frame" &&
          bounded.data?.byteLength &&
          (scope.tool === AgentTool.BROWSER || bounded.targetId)
        )
          this.#frame = bounded;
        const { data: _data, ...metadata } = bounded;
        this.#metadata = { ...this.#metadata, ...metadata, state: "ready" };

        for (const watch of this.watches.values()) watch.offer(bounded);

        if (bounded.state === "error") fail(bounded.detail ?? "Preview backend failed");
      },
      active: () => [...this.watches.values()].some((watch) => watch.capacity),
    };

    const backend = scope.tool === AgentTool.BROWSER ? browserPreview(context) : screenshotPreview(context);
    this.#backend = backend;
    this.#starting = backend.start();
    await cancellable(this.#starting, signal);

    return backend;
  }

  add(watch: PreviewWatch): void {
    this.watches.set(watch.id, watch);
    this.input.add(watch.id);
    watch.offer(this.#metadata);

    if (this.#frame) watch.offer(this.#frame);
  }

  async remove(id: string): Promise<void> {
    this.watches.delete(id);

    if (!this.watches.size) await this.close();
    else await this.input.remove(id);
  }

  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#frame = undefined;
    this.#abort.abort();
    this.#closed = this.#finish();

    return this.#closed;
  }

  async #finish(): Promise<void> {
    await Promise.allSettled([this.#ready, this.input.close()]);
    // Abort rejects the admission promise before a CLI acquiring a browser stream has finished.
    // Wait for that acquisition/release too, before native session cleanup can run.
    await this.#starting?.catch(() => undefined);
    await this.#backend?.close().catch(() => undefined);
  }
}
