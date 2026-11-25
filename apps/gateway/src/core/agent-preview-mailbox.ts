import type { AgentPreviewEvent } from "@canopy/contracts";

/** One newest frame and one newest metadata update; producers never build a frame queue. */
export class AgentPreviewMailbox {
  #frame: AgentPreviewEvent | undefined;
  #metadata: AgentPreviewEvent | undefined;
  #wake: (() => void) | undefined;
  #closed = false;
  #cause: Error | undefined;

  push(event: AgentPreviewEvent): bigint | undefined {
    if (this.#closed) return;
    let discarded: bigint | undefined;

    if (event.state === "frame") this.#frame = event;
    else {
      this.#metadata = event;

      if (
        event.state === "ready" &&
        (this.#frame?.followingAgent || this.#frame?.agentObservation) &&
        (!event.targetId || this.#frame.targetId !== event.targetId)
      ) {
        discarded = this.#frame.frameId;
        this.#frame = undefined;
      }
    }

    if (event.state === "closed" || event.state === "error") this.#frame = undefined;
    this.#notify();

    return discarded;
  }

  async next(): Promise<AgentPreviewEvent | undefined> {
    for (;;) {
      if (this.#closed) {
        if (this.#cause) throw this.#cause;

        return;
      }

      const value = this.#metadata ?? this.#frame;

      if (value) {
        if (this.#metadata) this.#metadata = undefined;
        else this.#frame = undefined;

        return value;
      }

      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }

  close(cause?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cause = cause;
    this.#frame = this.#metadata = undefined;
    this.#notify();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
