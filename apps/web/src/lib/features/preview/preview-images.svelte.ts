import type { AgentPreviewEvent } from "@canopy/contracts";

/** A completed visual call can leave an exact tool image or a window that is still changing.
 * Hold only the exact image, until the worker invalidates its source or another call starts. */
export class PreviewImages {
  frame = $state.raw<AgentPreviewEvent>();
  #observation: AgentPreviewEvent | undefined;
  #held: AgentPreviewEvent | undefined;
  #activity = "";
  #settled = false;

  constructor(readonly acknowledge: (frame: AgentPreviewEvent) => void) {}

  clear(): void {
    this.frame = this.#observation = this.#held = undefined;
  }

  invalidate(): void {
    const pending = this.#held ?? this.frame;

    if (pending) this.acknowledge(pending);
    this.clear();
  }

  activity(id: string, settled: boolean): void {
    if (this.#activity !== id && this.#observation) this.invalidate();
    else if (this.#settled && !settled && this.#held) this.invalidate();

    this.#activity = id;
    this.#settled = settled;

    if (settled && this.#observation && this.frame !== this.#observation) {
      this.#held = this.frame;
      this.frame = this.#observation;
    }
  }

  receive(event: AgentPreviewEvent): void {
    if (event.agentObservation) {
      this.#held = undefined;
      this.#observation = event;
    } else if (this.#observation?.targetId !== event.targetId) this.#observation = undefined;

    if (this.#settled && this.#observation && !event.agentObservation) {
      this.#held = event;

      return;
    }

    this.frame = event;
  }

  painted(event: AgentPreviewEvent): void {
    if (event !== this.#held) this.acknowledge(event);
  }
}
