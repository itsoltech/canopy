import { Provider, type Command, type ThreadStorageCleanupRequest } from "@canopy/contracts";
import { harnessOf } from "@canopy/domain/harnesses";
import { Effect } from "effect";
import { Journal, type StorageCleanupGrant } from "../journal/index.ts";
import { runtimeBusy, runtimeKeys } from "./instance-runtimes.ts";
import type { HostContext } from "./host-context.ts";
import { isManagedStorageHome, removeThreadStorage } from "./storage-files.ts";
import { cleanupHome, validatedCleanupHome } from "./storage-cleanup-homes.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[a-z0-9][a-z0-9_-]{0,159}$/i;

type CleanupRequest = { readonly remaining: Set<string>; readonly completed: Set<string> };

/** Grants survive restart; no age, absence, archive, or soft-delete state is local authorization. */
export class WorkerStorageCleanup {
  #running: Promise<void> | undefined;
  #users = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #requests = new Map<string, CleanupRequest>();
  constructor(readonly ctx: HostContext) {}
  settled(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }
  async use<A>(work: () => Promise<A>): Promise<A> {
    while (this.#running) await this.#running;
    // No await between observing the cleanup gate and reserving admission.
    this.#users++;

    try {
      return await work();
    } finally {
      this.#users--;
    }
  }
  async rejects(command: Command): Promise<boolean> {
    const kind = command.kind;
    const ids: string[] = [];

    switch (kind.case) {
      case "createThread":
        if (kind.value.fork?.sourceThreadId) ids.push(kind.value.fork.sourceThreadId);

        if (kind.value.thread?.threadId) ids.push(kind.value.thread.threadId);
        break;
      case "startTurn":
      case "rewindThread":
      case "setGoal":
        if (kind.value.thread?.threadId) ids.push(kind.value.thread.threadId);
        break;
      case "steerTurn":
        ids.push(kind.value.threadId);
        break;
    }

    for (const id of ids)
      if (await this.ctx.state.options.runtime.runPromise(Journal.use((j) => j.hasStorageCleanup(id)))) return true;

    return false;
  }
  start(): void {
    this.#timer ??= setInterval(() => this.tick(), 30_000);
    this.#timer.unref();
    this.tick();
  }
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.settled();
  }
  accept(request: ThreadStorageCleanupRequest): void {
    if (!request.requestId || request.scopes.length > 128) return;

    const work = async () => {
      const ids = new Set<string>();

      for (const scope of request.scopes) {
        if (
          !UUID.test(scope.threadId) ||
          scope.providerThreadIds.some((id) => !ID.test(id)) ||
          !ID.test(scope.providerProfileId || "native")
        )
          continue;

        if (!harnessOf(scope.provider)) continue;

        const home = await cleanupHome(this.ctx, {
          ...scope,
          providerProfileId: scope.providerProfileId || "native",
        });

        if (!home) continue;

        await this.ctx.state.options.runtime.runPromise(
          Journal.use((j) =>
            j.grantStorageCleanup({
              threadId: scope.threadId,
              provider: scope.provider,
              providerProfileId: scope.providerProfileId || "native",
              providerThreadIds: scope.providerThreadIds,
              homePath: home,
            }),
          ),
        );
        this.ctx.state.closedThreads.add(scope.threadId);
        ids.add(scope.threadId);
      }

      if (!ids.size) {
        this.ctx.ops.send({ case: "threadStorageCleanup", value: { requestId: request.requestId } });

        return;
      }

      // The gateway may rotate an unanswered request after its timeout. Durable grants remain authoritative; the
      // in-memory reply accumulator belongs only to the current request and must not grow with stale IDs.
      this.#requests.clear();
      this.#requests.set(request.requestId, { remaining: ids, completed: new Set() });
      await this.#clean();
    };

    this.#queue(work);
  }
  tick(): void {
    if (!this.#running) this.#queue(() => this.#clean());
  }
  #queue(work: () => Promise<void>): void {
    const run = (this.#running ?? Promise.resolve()).then(work).catch(() => {
      this.ctx.ops.log("Worker storage cleanup deferred; durable grants will retry");
    });

    this.#running = run;
    void run.finally(() => {
      if (this.#running === run) this.#running = undefined;
    });
  }
  async #clean(): Promise<void> {
    if (this.#users) return;
    const state = this.ctx.state;
    const previous = state.runtimeReconcile;
    const gate = Promise.withResolvers<void>();
    state.runtimeReconcile = previous.then(() => gate.promise);
    await previous;
    let failure: unknown;

    try {
      await this.#remove();
    } catch (error) {
      failure = error;
    } finally {
      gate.resolve();
    }

    await this.ctx.ops.reconcileRuntimes();

    if (failure) throw failure;
  }
  async #remove(): Promise<void> {
    const state = this.ctx.state;

    // Import roots are configuration-owned. Before config arrives, neither source ownership nor the managed home is
    // authoritative, so a persisted grant waits rather than guessing a default.
    if (!state.config) return;

    // This also covers provider turns before their notification reaches HostEvents, and background processes.
    if (
      state.admitting ||
      state.running.size ||
      state.generations.size ||
      state.shellRuns.size ||
      state.shuttingDown ||
      [...runtimeKeys(this.ctx).keys()].some((key) => runtimeBusy(this.ctx, key))
    )
      return;

    const journalBusy = await state.options.runtime.runPromise(
      Journal.use((j) =>
        Effect.gen(function* () {
          return (
            (yield* j.cursors()).length > 0 ||
            (yield* j.openTurns()).length > 0 ||
            (yield* j.openBackgroundTasks()).length > 0 ||
            (yield* j.openShellInputs()).length > 0
          );
        }),
      ),
    );

    if (journalBusy) return;
    const grants = await state.options.runtime.runPromise(Journal.use((j) => j.pendingStorageCleanup()));

    if (!grants.length) {
      this.#replyRequests();

      return;
    }

    const ready: StorageCleanupGrant[] = [];

    for (const grant of grants) {
      const blocked = await state.options.runtime.runPromise(
        Journal.use((j) =>
          Effect.gen(function* () {
            return (
              (yield* j.cursors()).some((cursor) => cursor.threadId === grant.threadId) ||
              (yield* j.openTurns()).some((turn) => turn.threadId === grant.threadId) ||
              (yield* j.openBackgroundTasks()).some((task) => task.threadId === grant.threadId) ||
              (yield* j.openShellInputs()).some((input) => input.threadId === grant.threadId)
            );
          }),
        ),
      );

      if (
        !blocked &&
        ![...state.toolCalls.values()].some(({ call }) => call.threadId === grant.threadId) &&
        ![...state.interactions.values()].some(({ request }) => request.threadId === grant.threadId)
      )
        ready.push(grant);
    }

    if (!ready.length) return;

    // Admission waits for settled(). Close idle runtimes before erasing their session files, then rebuild them.
    for (const id of state.codex.keys()) await this.ctx.ops.stopCodex(id);

    for (const id of state.claude.keys()) await this.ctx.ops.stopClaude(id);

    for (const handle of state.acp.values()) await handle.runtime.close();
    state.acp.clear();

    // Closing an idle runtime can flush its final journal entries; those must be ACKed first too.
    if ((await state.options.runtime.runPromise(Journal.use((j) => j.cursors()))).length) return;

    for (const grant of ready) {
      const provider = harnessOf(grant.provider);

      if (!provider) continue;

      const home = await validatedCleanupHome(this.ctx, grant);

      const source =
        provider !== "antigravity" &&
        isManagedStorageHome(state.options.dataDir, home, grant.provider) &&
        state.imports.hasImportRootIntersection(provider, home);

      const protectedSessionIds = new Set(
        grant.providerThreadIds.filter(
          (id) =>
            // Claude bindings persist paths, not ownership or directory identity. A historical SHARED home can
            // have a managed-looking path after policy changes, so preserve native files without that proof.
            grant.provider === Provider.CLAUDE || source || state.imports.hasCopyManifest(provider, id),
        ),
      );

      removeThreadStorage(state.options.dataDir, grant, home, protectedSessionIds);
      await state.options.runtime.runPromise(Journal.use((j) => j.completeStorageCleanup(grant.threadId)));

      for (const request of this.#requests.values()) {
        if (request.remaining.delete(grant.threadId)) request.completed.add(grant.threadId);
      }
    }

    this.#replyRequests();
  }

  #replyRequests(): void {
    for (const [requestId, request] of this.#requests) {
      if (request.remaining.size) continue;
      this.ctx.ops.send({
        case: "threadStorageCleanup",
        value: { requestId, completedThreadIds: [...request.completed].sort() },
      });
      this.#requests.delete(requestId);
    }
  }
}
