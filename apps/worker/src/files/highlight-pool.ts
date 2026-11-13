import type { HighlightWindow } from "@canopy/syntax/window";
import type { HighlightReply, HighlightTask } from "./highlight-protocol.ts";

/** One lazy CPU executor, four waiting tasks; no parser work on the WorkerLink event loop. */
export class HighlightPool {
  #worker: Worker | undefined;
  #serial: Promise<void> = Promise.resolve();
  #pending = 0;
  #id = 0;
  #reject: ((cause: Error) => void) | undefined;
  #generation = 0;

  run(task: Omit<HighlightTask, "id">): Promise<HighlightWindow> {
    if (this.#pending >= 5) return Promise.reject(new Error("Highlighting is busy. The file remains readable."));
    const generation = this.#generation;
    this.#pending++;

    const result = this.#serial.then(() => {
      if (generation !== this.#generation) throw new Error("Highlighting was cancelled.");

      return this.#execute({ ...task, id: ++this.#id });
    });

    this.#serial = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => this.#pending--);
  }

  close() {
    this.#generation++;
    this.#reject?.(new Error("Highlighting was cancelled."));
    this.#reject = undefined;
    this.#worker?.terminate();
    this.#worker = undefined;
  }

  #execute(task: HighlightTask): Promise<HighlightWindow> {
    const worker = (this.#worker ??= new Worker(new URL("./highlight-executor.ts", import.meta.url)));

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;

      const finish = (error?: Error, value?: HighlightWindow) => {
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        this.#reject = undefined;

        if (error) {
          worker.terminate();
          this.#worker = undefined;
          reject(error);
        } else if (value) resolve(value);
      };

      const expired = () => finish(new Error("Highlighting took too long. The file remains readable."));
      this.#reject = (cause) => finish(cause);
      timer = setTimeout(expired, 10_000);
      worker.onerror = () => finish(new Error("Highlighting is unavailable. The file remains readable."));
      worker.onmessage = (event: MessageEvent<HighlightReply>) => {
        const reply = event.data;

        if (reply.id !== task.id) return;

        if ("ready" in reply) {
          clearTimeout(timer);
          timer = setTimeout(expired, 100);
          worker.postMessage({ run: task.id });
        } else if ("error" in reply) finish(new Error(reply.error));
        else finish(undefined, reply.result);
      };

      worker.postMessage({ prepare: task });
    });
  }
}
