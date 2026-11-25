import type { MessageInitShape } from "@bufbuild/protobuf";
import type { AgentPreviewCommand, AgentPreviewEventSchema, StartAgentPreview } from "@canopy/contracts";
import type { AgentTools } from "../agent-tools/index.ts";
import { PreviewGroup } from "./group.ts";
import { PreviewWatch } from "./watch.ts";
import { previewScope, validatePreviewInputs } from "./validation.ts";

export interface AgentPreviewsOptions {
  readonly tools: AgentTools;
  send(event: MessageInitShape<typeof AgentPreviewEventSchema>): void | Promise<void>;
}

interface Entry {
  watch: PreviewWatch;
  group: PreviewGroup;
  key: string;
}

/** Ephemeral previews belong to exactly one worker link; no frame or input enters a journal. */
export class AgentPreviews {
  readonly #options: AgentPreviewsOptions;
  readonly #watches = new Map<string, Entry>();
  readonly #groups = new Map<string, PreviewGroup>();
  readonly #closing = new Map<Promise<void>, string>();
  #closed = false;

  constructor(options: AgentPreviewsOptions) {
    this.#options = options;
  }

  accept(command: AgentPreviewCommand): void {
    if (this.#closed) return;
    const kind = command.kind;

    try {
      switch (kind.case) {
        case "start":
          this.#start(kind.value);
          break;
        case "stop":
          this.#stop(kind.value.previewId);
          break;
        case "ack":
          this.#watches.get(kind.value.previewId)?.watch.ack(kind.value.frameId);
          break;
        case "input": {
          const entry = this.#watches.get(kind.value.previewId);

          if (!entry) return;
          validatePreviewInputs(kind.value.inputs, kind.value.previewId);
          entry.group.input.enqueue(kind.value.previewId, kind.value.inputs);
          break;
        }
      }
    } catch (error) {
      if (!kind.case) return;
      const id = kind.value.previewId;
      this.#error(id, error instanceof Error ? error.message : "Preview command failed");
      this.#stop(id);
    }
  }

  #start(start: StartAgentPreview): void {
    const scope = previewScope(start);
    this.#stop(start.previewId);

    if (this.#watches.size >= 4) throw new Error("This worker already has four active preview viewers");

    const key = JSON.stringify([
      scope.tool,
      scope.session,
      scope.platform,
      scope.deviceId,
      scope.app,
      scope.windowId,
      start.followAgent,
      start.agentToolDefaults,
    ]);

    let group = this.#groups.get(key);

    if (!group) {
      if (this.#groups.size + this.#closing.size >= 4)
        throw new Error("Preview backends are busy closing; retry shortly");
      group = new PreviewGroup(
        this.#options.tools,
        scope,
        (detail) => {
          for (const [id, entry] of this.#watches) {
            if (entry.key === key) {
              this.#error(id, detail);
              this.#stop(id);
            }
          }
        },
        start.agentToolDefaults,
        start.followAgent,
      );
      this.#groups.set(key, group);
    }

    const watch = new PreviewWatch({
      id: start.previewId,
      threadId: start.threadId,
      maxFps: start.maxFps,
      capacityChanged: () => group.demand.changed(),
      send: (event) => this.#options.send(event),
      stop: () => {
        if (this.#watches.get(start.previewId)?.watch === watch) this.#stop(start.previewId);
      },
    });

    this.#watches.set(watch.id, { watch, group, key });
    group.add(watch);
  }

  #error(previewId: string, detail: string): void {
    void Promise.resolve()
      .then(() => this.#options.send({ previewId, state: "error", detail: detail.slice(0, 4096) }))
      .catch(() => undefined);
  }

  #stop(id: string): void {
    const entry = this.#watches.get(id);

    if (!entry) return;
    this.#watches.delete(id);
    entry.watch.close();
    const closing = entry.group.remove(id);

    if (!entry.group.watches.size) this.#groups.delete(entry.key);
    this.#closing.set(closing, entry.watch.threadId);
    void closing.finally(() => this.#closing.delete(closing)).catch(() => undefined);
  }

  async stopThread(threadId: string): Promise<void> {
    for (const [id, entry] of this.#watches) {
      if (entry.watch.threadId === threadId) this.#stop(id);
    }

    // Include watches already removed by stop/error/lease expiry while their backend is still closing.
    await Promise.allSettled([...this.#closing].flatMap(([pending, id]) => (id === threadId ? [pending] : [])));
  }

  async close(): Promise<void> {
    this.#closed = true;

    for (const id of this.#watches.keys()) this.#stop(id);
    await Promise.allSettled(this.#closing.keys());
  }
}
