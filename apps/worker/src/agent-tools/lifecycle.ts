import { agentToolSession } from "./scope.ts";

/** Fence admission before draining commands, including commands still discovering their runtime. */
export class AgentToolLifecycle {
  readonly #closed = new Set<string>();
  readonly #epochs = new Map<string, number>();
  readonly #active = new Map<string, Set<Promise<void>>>();
  readonly #closing = new Map<string, Promise<void>>();

  assertOpen(session: string): void {
    if (this.isClosed(session)) throw new Error("Automation is closed for this thread. Reopen the thread to continue.");
  }

  isClosed(session: string): boolean {
    return this.#closed.has(agentToolSession(session));
  }

  fence(session: string): void {
    const key = agentToolSession(session);
    this.#closed.add(key);
    this.#epochs.set(key, (this.#epochs.get(key) ?? 0) + 1);
  }

  run<T>(session: string, work: () => Promise<T>): Promise<T> {
    const key = agentToolSession(session);
    this.assertOpen(key);
    const active = this.#active.get(key) ?? new Set<Promise<void>>();
    this.#active.set(key, active);

    const task = Promise.resolve().then(() => {
      this.assertOpen(key);

      return work();
    });

    const done = task.then(
      () => undefined,
      () => undefined,
    );

    active.add(done);
    void done.then(() => {
      active.delete(done);

      if (!active.size) this.#active.delete(key);
    });

    return task;
  }

  close(session: string, cleanup: () => Promise<void>): Promise<void> {
    const key = agentToolSession(session);

    if (!key) return Promise.reject(new Error("Thread ID is required for automation cleanup"));
    this.fence(key);
    const pending = this.#closing.get(key);

    if (pending) return pending;
    const task = Promise.allSettled(this.#active.get(key) ?? []).then(cleanup);
    this.#closing.set(key, task);
    void task
      .finally(() => {
        if (this.#closing.get(key) === task) this.#closing.delete(key);
      })
      .catch(() => undefined);

    return task;
  }

  async open(session: string): Promise<void> {
    const key = agentToolSession(session);
    const epoch = this.#epochs.get(key);
    await this.#closing.get(key);

    if (this.#epochs.get(key) === epoch) this.#closed.delete(key);
  }
}
