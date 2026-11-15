import { create, toJsonString } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, type AgentPreviewInput } from "@canopy/contracts";

const MAX_INPUTS = 64;
const MAX_PENDING = 128;
const MAX_BATCH_BYTES = 24 * 1024;

export class PreviewInputQueue {
  #queue: AgentPreviewInput[] = [];
  #running = false;
  #scheduled = false;
  #disposed = false;

  constructor(
    private readonly send: (inputs: readonly AgentPreviewInput[]) => Promise<void>,
    private readonly overflow: () => void,
  ) {}

  push(input: AgentPreviewInput): void {
    if (this.#disposed) return;

    if (input.kind === "text" && new TextEncoder().encode(input.text).length > 8 * 1024) {
      let text = "";
      let bytes = 0;

      for (const char of input.text) {
        const size = new TextEncoder().encode(char).length;

        if (bytes + size > 8 * 1024) {
          this.push(create(AgentPreviewInputSchema, { kind: "text", text }));
          text = "";
          bytes = 0;
        }

        text += char;
        bytes += size;
      }

      if (text) this.push(create(AgentPreviewInputSchema, { kind: "text", text }));

      return;
    }

    if (input.kind === "pointer-move") {
      const last = this.#queue.at(-1);

      if (last?.kind === "pointer-move") {
        this.#queue[this.#queue.length - 1] = input;
        this.#schedule();

        return;
      }
    }

    if (this.#queue.length >= MAX_PENDING) {
      const move = this.#queue.findIndex((entry) => entry.kind === "pointer-move");

      if (move >= 0) this.#queue.splice(move, 1);
      else if (input.kind === "pointer-move") return;
      else {
        this.dispose();
        this.overflow();

        return;
      }
    }

    this.#queue.push(input);
    this.#schedule();
  }

  clear(): void {
    this.#queue = [];
  }

  dispose(): void {
    this.#disposed = true;
    this.clear();
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#flush();
    });
  }

  async #flush(): Promise<void> {
    if (this.#running || !this.#queue.length) return;
    this.#running = true;
    const batch: AgentPreviewInput[] = [];
    let bytes = 0;

    while (batch.length < MAX_INPUTS && this.#queue.length) {
      const next = this.#queue[0]!;
      const size = new TextEncoder().encode(toJsonString(AgentPreviewInputSchema, next)).length;

      if (bytes + size > MAX_BATCH_BYTES && batch.length) break;
      bytes += size;
      batch.push(this.#queue.shift()!);
    }

    try {
      await this.send(batch);
    } finally {
      this.#running = false;

      if (this.#queue.length) this.#schedule();
    }
  }
}
