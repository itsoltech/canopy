import { clone, create, toBinary } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, type AgentPreviewInput } from "@canopy/contracts";

const MAX_PENDING = 128;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_BATCH_BYTES = 24 * 1024;
const encoder = new TextEncoder();
const replaceable = (input: AgentPreviewInput) => input.kind === "pointer-move" || input.kind === "resize";

/** Only the current preview owns this queue. Failed or abandoned input is never retried. */
export class PreviewInputQueue {
  #pending: AgentPreviewInput[] = [];
  #running = false;
  #scheduled = false;
  #disposed = false;

  constructor(
    private readonly send: (inputs: AgentPreviewInput[]) => Promise<void>,
    private readonly failed: (detail: string) => void,
  ) {}

  push(input: AgentPreviewInput): void {
    if (this.#disposed) return;
    const textBytes = encoder.encode(input.text).byteLength;

    if (textBytes > MAX_TEXT_BYTES) {
      if (input.kind !== "text" || textBytes > MAX_PENDING * MAX_TEXT_BYTES) return this.#fail();
      this.#splitText(input.text);

      return;
    }

    if (toBinary(AgentPreviewInputSchema, input).byteLength > MAX_BATCH_BYTES - 8) return this.#fail();
    const last = this.#pending.at(-1);

    if (replaceable(input) && last?.kind === input.kind) {
      this.#pending[this.#pending.length - 1] = clone(AgentPreviewInputSchema, input);
      this.#schedule();

      return;
    }

    if (this.#pending.length >= MAX_PENDING) {
      const index = this.#pending.findIndex(replaceable);

      if (index >= 0) this.#pending.splice(index, 1);
      else if (replaceable(input)) return;
      else return this.#fail();
    }

    this.#pending.push(clone(AgentPreviewInputSchema, input));
    this.#schedule();
  }

  #splitText(value: string): void {
    let text = "";
    let bytes = 0;

    for (const character of value) {
      if (this.#disposed) return;
      const size = encoder.encode(character).byteLength;

      if (bytes + size > MAX_TEXT_BYTES) {
        this.push(create(AgentPreviewInputSchema, { kind: "text", text }));
        text = "";
        bytes = 0;
      }

      text += character;
      bytes += size;
    }

    if (text) this.push(create(AgentPreviewInputSchema, { kind: "text", text }));
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending = [];
  }

  #fail(detail = "Input could not keep up. Retry the preview to continue."): void {
    this.dispose();
    this.failed(detail);
  }

  #schedule(): void {
    if (this.#scheduled || this.#disposed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#flush();
    });
  }

  async #flush(): Promise<void> {
    if (this.#running || this.#disposed || !this.#pending.length) return;
    this.#running = true;
    const batch: AgentPreviewInput[] = [];
    let bytes = 0;

    while (batch.length < 64 && this.#pending.length) {
      const next = this.#pending[0]!;
      const size = toBinary(AgentPreviewInputSchema, next).byteLength + 8;

      if (bytes + size > MAX_BATCH_BYTES) break;
      bytes += size;
      batch.push(this.#pending.shift()!);
    }

    try {
      await this.send(batch);
    } catch {
      if (!this.#disposed) this.#fail("Check the connection, then retry.");
    } finally {
      this.#running = false;

      if (this.#pending.length) this.#schedule();
    }
  }
}
