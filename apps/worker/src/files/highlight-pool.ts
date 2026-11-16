import type { HighlightWindow } from "@canopy/syntax/window";
import type { HighlightReply, HighlightTask } from "./highlight-protocol.ts";

interface QueuedHighlight {
  threadId: string;
  task?: Omit<HighlightTask, "id">;
  reject: (cause: Error) => void;
}

/** One lazy CPU executor, four waiting tasks; no parser work on the WorkerLink event loop. */
export class HighlightPool {
  #worker: Worker | undefined;
  #serial: Promise<void> = Promise.resolve();
  #id = 0;
  #reject: ((cause: Error) => void) | undefined;
  #tasks = new Set<QueuedHighlight>();
  #threads = new Set<string>();
  #activeThread: string | undefined;

  run(task: Omit<HighlightTask, "id">): Promise<HighlightWindow> {
    if (this.#tasks.size >= 5) return Promise.reject(new Error("Highlighting is busy. The file remains readable."));
    const result = Promise.withResolvers<HighlightWindow>();
    const queued: QueuedHighlight = { threadId: task.threadId, task, reject: result.reject };
    this.#tasks.add(queued);
    this.#threads.add(task.threadId);

    this.#serial = this.#serial.then(async () => {
      const next = queued.task;
      delete queued.task;

      if (!next) return;
      this.#activeThread = next.threadId;

      try {
        result.resolve(await this.#execute({ ...next, id: ++this.#id }));
      } catch (cause) {
        result.reject(cause);
      }
    });

    return result.promise.finally(() => this.#tasks.delete(queued));
  }

  closeThread(threadId: string) {
    for (const queued of this.#tasks) {
      if (queued.threadId !== threadId) continue;
      delete queued.task;
      queued.reject(new Error("Highlighting was cancelled."));
      this.#tasks.delete(queued);
    }

    if (this.#activeThread === threadId) this.#reject?.(new Error("Highlighting was cancelled."));
    this.#threads.delete(threadId);

    if (this.#threads.size) this.#worker?.postMessage({ closeThread: threadId });
    else {
      this.#worker?.terminate();
      this.#worker = undefined;
    }
  }

  close() {
    for (const threadId of this.#threads) this.closeThread(threadId);
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
        this.#activeThread = undefined;

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
