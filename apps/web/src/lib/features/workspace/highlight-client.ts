import type { HighlightWindow, SourceChange } from "@canopy/syntax/window";
import type { HighlightCommand, HighlightReply } from "./highlight-protocol.ts";

let active: HighlightClient | undefined;

/** Only the active reader/editor owns an executor. No tokenizer enters the main-thread graph. */
export function openHighlight(path: string, source: string): HighlightClient {
  active?.close();
  active = new HighlightClient(path, source);

  return active;
}

export class HighlightClient {
  readonly #worker: Worker;
  #revision = 1;
  #ready = 0;
  #id = 0;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #initializing: ReturnType<typeof setTimeout> | undefined;
  #pending:
    | {
        command: Extract<HighlightCommand, { kind: "window" }>;
        resolve: (result: HighlightWindow) => void;
        reject: (cause: Error) => void;
      }
    | undefined;

  constructor(path: string, source: string) {
    this.#worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    this.#worker.onmessage = (event: MessageEvent<HighlightReply>) => {
      const reply = event.data;

      if (reply.revision !== this.#revision || this.#closed) return;

      if (reply.kind === "ready") {
        clearTimeout(this.#initializing);
        this.#ready = reply.revision;
        this.#send();
      } else if (reply.kind === "error") this.close();
      else if (reply.id === this.#pending?.command.id) {
        clearTimeout(this.#timer);
        this.#pending.resolve(reply.result);
        this.#pending = undefined;
      }
    };

    this.#worker.onerror = () => this.close();
    this.#worker.postMessage({ kind: "source", revision: this.#revision, path, source } satisfies HighlightCommand);
    this.#initializing = setTimeout(() => this.close(), 10_000);
  }

  change(changes: readonly SourceChange[]) {
    if (this.#closed) return;
    this.#cancel();
    this.#revision++;
    this.#worker.postMessage({ kind: "changes", revision: this.#revision, changes } satisfies HighlightCommand);
  }

  window(start: number, count: number): Promise<HighlightWindow> {
    this.#cancel();

    if (this.#closed) return Promise.reject(new Error("Highlighting is unavailable. The file remains readable."));

    return new Promise((resolve, reject) => {
      this.#pending = {
        command: { kind: "window", id: ++this.#id, revision: this.#revision, start, count: Math.min(200, count) },
        resolve,
        reject,
      };
      this.#send();
    });
  }

  #send() {
    if (this.#ready !== this.#revision || !this.#pending) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.close(), 100);
    this.#worker.postMessage(this.#pending.command);
  }

  #cancel() {
    clearTimeout(this.#timer);
    this.#pending?.reject(new Error("Highlighting was cancelled."));
    this.#pending = undefined;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#initializing);
    this.#cancel();
    this.#worker.terminate();

    if (active === this) active = undefined;
  }
}
