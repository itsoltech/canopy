import { bindProjectSecretFilter, projectSecretGuard } from "./project-secret-guard.ts";

// Output already queued by the harness can arrive after turn_finished.
const OUTPUT_DRAIN_MS = 30_000;

interface ProjectTurn {
  readonly id: string;
  readonly fence: AbortController;
  readonly background: Set<string>;
  readonly values: Set<string>;
  readonly privateLocations: Set<string>;
  requested: boolean;
}

interface ThreadTurns {
  active?: ProjectTurn;
  readonly draining: Map<ProjectTurn, ReturnType<typeof setTimeout> | undefined>;
  readonly unbind: () => void;
}

export class ProjectSecretTurns {
  readonly #threads = new Map<string, ThreadTurns>();

  constructor(
    readonly removeFiles: (threadId: string, turnId: string) => void,
    readonly drainMs = OUTPUT_DRAIN_MS,
  ) {}

  begin(threadId: string, turnId: string): void {
    const thread = this.#getThread(threadId);
    const previous = thread.active;

    if (previous?.id === turnId) return;
    thread.active = {
      id: turnId,
      fence: new AbortController(),
      background: new Set(),
      values: new Set(),
      privateLocations: new Set(),
      requested: false,
    };

    if (previous) this.#finish(threadId, thread, previous);
  }

  signal(threadId: string, turnId: string): AbortSignal | undefined {
    return projectSecretGuard(threadId).isReady() ? this.memorySignal(threadId, turnId) : undefined;
  }

  /**
   * The running turn for a value that stays in worker memory (an Agent Browser login): it never reaches the
   * harness's files or environment, so it does not wait for the harness's output filter.
   */
  memorySignal(threadId: string, turnId: string): AbortSignal | undefined {
    const active = this.#threads.get(threadId)?.active;

    if (active?.id === turnId && !active.fence.signal.aborted) return active.fence.signal;

    return undefined;
  }

  requestSignal(threadId: string, turnId: string): AbortSignal | undefined {
    const signal = this.signal(threadId, turnId);
    const active = this.#threads.get(threadId)?.active;

    if (signal && active) active.requested = true;

    return signal;
  }

  add(threadId: string, turnId: string, value: string, file?: string, requestId?: string): void {
    const active = this.#threads.get(threadId)?.active;

    if (active?.id !== turnId) return;
    active.values.add(value);

    if (file) active.privateLocations.add(file);

    if (requestId) active.privateLocations.add(requestId);
  }

  fence(threadId: string, turnId?: string): void {
    const active = this.#threads.get(threadId)?.active;

    if (active && (!turnId || active.id === turnId)) {
      active.fence.abort();
      this.removeFiles(threadId, active.id);
    }
  }

  finish(threadId: string, turnId: string): void {
    const thread = this.#threads.get(threadId);

    if (!thread?.active || thread.active.id !== turnId) return;
    const active = thread.active;
    delete thread.active;
    this.#finish(threadId, thread, active);
  }

  finishThread(threadId: string): void {
    const active = this.#threads.get(threadId)?.active;

    if (active) this.finish(threadId, active.id);
  }

  background(threadId: string, turnId: string, itemId: string, running: boolean): void {
    const thread = this.#threads.get(threadId);

    if (!thread) return;

    if (running) {
      const owner = [thread.active, ...thread.draining.keys()].find((turn) => turn?.id === turnId);

      if (!owner) return;
      owner.background.add(itemId);

      if (thread.draining.has(owner)) this.#drain(threadId, thread, owner);

      return;
    }

    thread.active?.background.delete(itemId);

    for (const turn of thread.draining.keys()) if (turn.background.delete(itemId)) this.#drain(threadId, thread, turn);
  }

  fenceAll(): void {
    for (const threadId of this.#threads.keys()) this.fence(threadId);
  }

  close(): void {
    this.fenceAll();

    for (const [threadId, thread] of this.#threads) {
      projectSecretGuard(threadId).reset();
      thread.unbind();

      for (const timer of thread.draining.values()) if (timer) clearTimeout(timer);
    }

    this.#threads.clear();
  }

  #getThread(threadId: string): ThreadTurns {
    const current = this.#threads.get(threadId);

    if (current) return current;

    const thread: ThreadTurns = {
      draining: new Map(),
      unbind: bindProjectSecretFilter(threadId, {
        values: () => this.#values(thread),
        journalValues: () => this.#values(thread, true),
        retains: (turnId) =>
          (thread.active?.id === turnId && thread.active.values.size > 0) ||
          [...thread.draining.keys()].some((turn) => turn.id === turnId),
        fence: () => {
          // Turn admission can precede the old provider process closing. Only a turn that requested
          // or received a lease may have deliveries still in flight from the prior session.
          const active = thread.active;

          if (active && (active.requested || active.values.size)) this.fence(threadId, active.id);
        },
      }),
    };

    this.#threads.set(threadId, thread);

    return thread;
  }

  *#values(thread: ThreadTurns, journal = false): Iterable<string> {
    const turns = thread.active ? [thread.active, ...thread.draining.keys()] : thread.draining.keys();

    for (const turn of turns) {
      yield* turn.values;

      if (journal) yield* turn.privateLocations;
    }
  }

  #finish(threadId: string, thread: ThreadTurns, turn: ProjectTurn): void {
    turn.fence.abort();
    this.removeFiles(threadId, turn.id);

    if (turn.values.size) this.#drain(threadId, thread, turn);

    this.#release(threadId, thread);
  }

  #drain(threadId: string, thread: ThreadTurns, turn: ProjectTurn): void {
    const scheduled = thread.draining.get(turn);

    if (scheduled) clearTimeout(scheduled);

    if (turn.background.size) {
      thread.draining.set(turn, undefined);

      return;
    }

    const timer = setTimeout(() => {
      thread.draining.delete(turn);
      this.#release(threadId, thread);
    }, this.drainMs);

    thread.draining.set(turn, timer.unref());
  }

  #release(threadId: string, thread: ThreadTurns): void {
    if (thread.active || thread.draining.size) return;
    thread.unbind();
    this.#threads.delete(threadId);
  }
}
