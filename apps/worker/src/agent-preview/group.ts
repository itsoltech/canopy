import { AgentTool, type RunAgentTool, type AgentToolSessionDefaults } from "@canopy/contracts";
import type { AgentTools } from "../agent-tools/index.ts";
import { browserPreview } from "./browser.ts";
import { screenshotPreview } from "./screenshots.ts";
import { followDesktopPreview } from "./desktop-follow-preview.ts";
import { FrameDemand } from "./frame-demand.ts";
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
  readonly demand = new FrameDemand();
  readonly input: PreviewInputQueue;
  readonly #abort = new AbortController();
  readonly #ready: Promise<PreviewBackend>;
  readonly #followAgent: boolean;
  #backend: PreviewBackend | undefined;
  #starting: Promise<void> | undefined;
  #metadata: PreviewUpdate = { state: "connecting" };
  #frame: PreviewUpdate | undefined;
  #frameCurrent: (() => boolean) | undefined;
  #currentCursor: PreviewRuntime["desktopCursor"] | undefined;
  #closed: Promise<void> | undefined;

  constructor(
    tools: AgentTools,
    scope: RunAgentTool,
    fail: (detail: string) => void,
    defaults?: AgentToolSessionDefaults,
    followAgent = false,
  ) {
    this.#followAgent = followAgent;
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
    const runtime = new PreviewRuntime(resolved, signal, this.#followAgent);
    this.#currentCursor = () => runtime.desktopCursor();

    const context = {
      runtime,
      signal,
      emit: (update: PreviewUpdate, stillCurrent?: () => boolean) => {
        if (signal.aborted || (stillCurrent && !stillCurrent())) return;
        const bounded = previewMetadata(update);
        const targetChanged = bounded.targetId !== undefined && bounded.targetId !== this.#metadata.targetId;

        if (this.#followAgent) {
          // Keep the model's current image for late joiners even after other viewers receive live frames.
          if (!bounded.followingAgent) {
            this.#frame = bounded.agentObservation ? bounded : undefined;
            this.#frameCurrent = this.#frame && stillCurrent;
          }
        } else {
          if (targetChanged || (scope.tool !== AgentTool.BROWSER && !bounded.targetId)) this.#frame = undefined;

          if (bounded.state === "error" || bounded.state === "closed") this.#frame = undefined;
          else if (
            bounded.state === "frame" &&
            bounded.data?.byteLength &&
            (scope.tool === AgentTool.BROWSER || bounded.targetId)
          )
            this.#frame = bounded;
        }

        const {
          data: _data,
          cursor: _cursor,
          followingAgent: _following,
          agentObservation: _observation,
          ...metadata
        } = bounded;

        if (!this.#followAgent || bounded.state !== "frame")
          this.#metadata = { ...this.#metadata, ...metadata, state: "ready" };

        for (const watch of this.watches.values()) watch.offer(bounded, this.#currentCursor, stillCurrent);

        if (bounded.state === "error") fail(bounded.detail ?? "Preview backend failed");
      },
      active: () => [...this.watches.values()].some((watch) => watch.capacity),
      waitForCapacity: (sourceSignal: AbortSignal, captureMs = 0) =>
        this.demand.wait(sourceSignal, () =>
          Math.max(0, Math.min(...Array.from(this.watches.values(), (watch) => watch.nextFrameIn)) - captureMs),
        ),
    };

    const backend = this.#followAgent
      ? followDesktopPreview(context)
      : scope.tool === AgentTool.BROWSER
        ? browserPreview(context)
        : screenshotPreview(context);

    this.#backend = backend;
    this.#starting = backend.start();
    await cancellable(this.#starting, signal);

    return backend;
  }

  add(watch: PreviewWatch): void {
    this.watches.set(watch.id, watch);
    this.input.add(watch.id);
    watch.offer(this.#metadata);

    if (this.#frame) {
      const cursor = this.#frame.cursor;
      watch.offer(
        cursor ? { ...this.#frame, cursor: { ...cursor, click: false } } : this.#frame,
        this.#currentCursor,
        this.#frameCurrent,
      );
    }

    this.demand.changed();
  }

  async remove(id: string): Promise<void> {
    this.watches.delete(id);
    this.demand.changed();

    if (!this.watches.size) await this.close();
    else await this.input.remove(id);
  }

  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#frame = undefined;
    this.#frameCurrent = undefined;
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
