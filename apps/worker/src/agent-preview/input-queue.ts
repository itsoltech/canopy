import type { AgentPreviewInput } from "@canopy/contracts";
import type { PreviewBackend } from "./types.ts";

interface Job {
  owner: string;
  inputs: AgentPreviewInput[];
}

/** Keep state transitions ordered while replacing obsolete pointer movement and batching text. */
export class PreviewInputQueue {
  readonly #queue: Job[] = [];
  readonly #backend: () => Promise<PreviewBackend>;
  readonly #error: (owner: string, error: Error) => void;
  readonly #owners = new Set<string>();
  #running: Promise<void> | undefined;
  #current: { owner: string; done: Promise<void> } | undefined;
  #closed = false;

  constructor(backend: () => Promise<PreviewBackend>, error: (owner: string, error: Error) => void) {
    this.#backend = backend;
    this.#error = error;
  }

  add(owner: string): void {
    this.#owners.add(owner);
  }

  enqueue(owner: string, inputs: readonly AgentPreviewInput[]): void {
    if (this.#closed || !this.#owners.has(owner)) return;
    const tail = this.#queue.at(-1);

    if (tail?.owner === owner && tail.inputs.length + inputs.length <= 64) tail.inputs.push(...inputs);
    else if (this.#queue.length < 8) this.#queue.push({ owner, inputs: [...inputs] });
    else throw new Error("Preview input queue is full; release controls and retry");
    this.#pump();
  }

  #pump(): void {
    this.#running ??= this.#drain().finally(() => {
      this.#running = undefined;

      if (!this.#closed && this.#queue.length) this.#pump();
    });
    void this.#running.catch(() => undefined);
  }

  async #drain(): Promise<void> {
    const backend = await this.#backend();
    let job: Job | undefined;

    while (!this.#closed && (job = this.#queue.shift())) {
      for (const input of this.#coalesce(job.inputs)) {
        if (!this.#owners.has(job.owner) || this.#closed) break;

        try {
          const done = backend.input([input], job.owner);
          this.#current = { owner: job.owner, done };
          await done;
        } catch (error) {
          await backend.release(job.owner).catch(() => undefined);
          this.#error(job.owner, error instanceof Error ? error : new Error("Preview input failed"));
        } finally {
          this.#current = undefined;
        }
      }
    }
  }

  #coalesce(inputs: readonly AgentPreviewInput[]): AgentPreviewInput[] {
    const result: AgentPreviewInput[] = [];

    for (const input of inputs) {
      const previous = result.at(-1);

      if (input.kind === "pointer-move" && previous?.kind === "pointer-move") result[result.length - 1] = input;
      else if (
        input.kind === "text" &&
        previous?.kind === "text" &&
        Buffer.byteLength(previous.text + input.text) <= 8192
      )
        result[result.length - 1] = { ...previous, text: previous.text + input.text };
      else result.push(input);
    }

    return result;
  }

  async remove(owner: string): Promise<void> {
    this.#owners.delete(owner);

    for (let index = this.#queue.length - 1; index >= 0; index--) {
      if (this.#queue[index]?.owner === owner) this.#queue.splice(index, 1);
    }

    if (this.#current?.owner === owner) await this.#current.done.catch(() => undefined);
    const backend = await this.#backend().catch(() => undefined);
    await backend?.release(owner).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#owners.clear();
    this.#queue.length = 0;
    await this.#running?.catch(() => undefined);
  }
}
