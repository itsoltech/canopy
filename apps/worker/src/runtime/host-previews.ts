import type { AgentPreviewCommand, ThreadLifecycle } from "@canopy/contracts";
import { AgentPreviews } from "../agent-preview/index.ts";
import type { AgentTools } from "../agent-tools/index.ts";
import type { GatewayLink } from "../gateway-link/index.ts";

/** Preview callbacks retain their original link, including during replacement and cleanup. */
export class HostPreviews {
  #manager: AgentPreviews | undefined;
  #link: GatewayLink | undefined;
  readonly #closing = new Map<AgentPreviews, Promise<void>>();

  constructor(
    readonly tools: AgentTools,
    readonly threadClosed: (id: string) => boolean,
  ) {}

  attach(link: GatewayLink): void {
    if (this.#manager) this.#retire(this.#manager);
    this.#link = link;
    this.#manager = new AgentPreviews({
      tools: this.tools,
      send: (event) => link.send({ case: "agentPreview", value: event }),
    });
  }

  detach(link: GatewayLink): void {
    if (this.#link !== link) return;
    void this.close();
  }

  accept(command: AgentPreviewCommand): void {
    if (command.kind.case === "start" && this.threadClosed(command.kind.value.threadId)) {
      this.#link?.send({
        case: "agentPreview",
        value: { previewId: command.kind.value.previewId, state: "error", detail: "The thread is archived" },
      });

      return;
    }

    this.#manager?.accept(command);
  }

  lifecycle(state: ThreadLifecycle, closed: Set<string>): void {
    if (state.replace) closed.clear();

    for (const id of state.closedThreadIds) {
      closed.add(id);
      void this.#manager?.stopThread(id);
    }

    for (const id of state.openedThreadIds) closed.delete(id);
  }

  async stopThread(threadId: string): Promise<void> {
    const managers = new Set(this.#closing.keys());

    if (this.#manager) managers.add(this.#manager);
    await Promise.all([...managers].map((manager) => manager.stopThread(threadId)));
  }

  #retire(manager: AgentPreviews): void {
    if (this.#closing.has(manager)) return;
    const pending = manager.close();
    this.#closing.set(manager, pending);
    void pending.finally(() => this.#closing.delete(manager)).catch(() => {});
  }

  async close(): Promise<void> {
    const manager = this.#manager;
    this.#manager = undefined;
    this.#link = undefined;

    if (manager) this.#retire(manager);
    await Promise.allSettled(this.#closing.values());
  }
}
