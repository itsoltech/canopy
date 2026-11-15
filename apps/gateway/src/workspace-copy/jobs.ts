import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { ConnectError } from "@connectrpc/connect";
import { splitId } from "@canopy/domain/computers";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { z } from "zod";
import type { GatewayCore } from "../core/core.ts";
import { coreLog } from "../core/core-broadcast.ts";
import { coreState, describeError, InvalidError, UnavailableError } from "../core/core-context.ts";
import { coreWorkers } from "../core/core-providers.ts";
import { queryFamily } from "../diagnostics/query-context.ts";
import { peerOf } from "../api/routed-home.ts";
import { Invalid, NotFound } from "../store/index.ts";
import { unwrap } from "../api/ui-errors.ts";
import { copyAttempt, type CopyAttemptProgress, type CopySelection } from "./attempt.ts";
import { CopyJobStore, jobMessage, OPEN_STATUSES, type JobRow } from "./jobs-store.ts";
import { ownedCopyWorkspace, pathHash } from "./source.ts";
import { targetCall } from "./routes.ts";

/** Background copies running at once; more wait as queued. Each one holds at most COPY_LANES frames. */
const RUNNING = 3;
const TICK_MS = 10_000;

/** Progress reaches clients a few times a second and the database every few seconds. */
const PUBLISH_MS = 250;
const PERSIST_MS = 2_000;

/** Attempts in a row without progress before a copy fails; progress resets the count. */
const ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 3_000, 5_000];
const OPEN: ReadonlySet<string> = new Set(OPEN_STATUSES);

interface Running {
  stop: AbortController;
  reason?: "cancel" | "shutdown";
  done: Promise<void>;
}

/**
 * Durable background copies (docs/workspace-copy.md, "Kopiowanie w tle"). The row holds the selection as path
 * hashes; each attempt reads a fresh file list, resumes the target's staging directory and sends only what is
 * missing. Closing a client never stops a copy; a restart of the gateway or a worker continues it.
 */
export class WorkspaceCopyJobs {
  readonly store: CopyJobStore;
  readonly #core: GatewayCore;
  readonly #running = new Map<string, Running>();
  /** The client's own file list for the first attempt; later attempts select by path hash. */
  readonly #fresh = new Map<string, CopySelection>();
  readonly #live = new Map<string, { row: JobRow; currentFile: string }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  #ticks = 0;
  /** Runs before every frame a job writes; tests take a worker or the gateway away at an exact frame with it. */
  beforeWrite: (id: string, chunks: number) => Promise<void> | void = () => {};

  constructor(core: GatewayCore) {
    this.#core = core;
    this.store = new CopyJobStore(
      (use) =>
        core[coreState].actions.run(Effect.flatMap(SqlClient.SqlClient, use).pipe(queryFamily("worktrees.store"))),
      () => core[coreState].options.userId,
    );
  }

  start(): void {
    this.#stopped = false;
    this.#timer ??= setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  /** Running copies stop where they are; the next start resumes them. */
  async stop(): Promise<void> {
    this.#stopped = true;

    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;

    for (const running of this.#running.values()) {
      running.reason = "shutdown";
      running.stop.abort();
    }

    await Promise.allSettled([...this.#running.values()].map((r) => r.done));
  }

  /** Starts a copy and returns once its selection is authorized and the destination prepared (or it is queued). */
  async startCopy(request: ui.CopyWorkspaceRequest): Promise<ui.WorkspaceCopyJob> {
    if (!z.uuid().safeParse(request.transferKey).success) throw new InvalidError("Invalid transfer identifier.");

    if (!request.ignoredSelection || request.paths.length)
      throw new InvalidError("Update this app to copy workspaces in the background.");
    const existing = await this.store.get(request.transferKey);

    if (existing) return this.#message(existing);
    await this.store.insert({
      id: request.transferKey,
      sourceRef: request.sourceRef,
      targetRef: request.targetRef,
      projectRef: request.projectRef,
      parentPath: request.parentPath,
      name: request.name,
      targetName: request.targetName || (await this.#workerName(request.targetRef)),
      ignoredHashes: request.ignoredSelection.paths.map(pathHash),
      secretHashes: request.confirmedSecrets.map(pathHash),
    });
    this.#fresh.set(request.transferKey, {
      manifestToken: request.manifestToken,
      ignoredPaths: request.ignoredSelection.paths,
      confirmedSecrets: request.confirmedSecrets,
    });
    const row = await this.#row(request.transferKey);

    if (this.#stopped || this.#running.size >= RUNNING) {
      this.#publish(row);

      return this.#message(row);
    }

    // The first steps run while the client waits: an unconfirmed secret or a taken directory is its error.
    const ready = Promise.withResolvers<void>();
    this.#drive(row, ready);
    await ready.promise;

    return this.#message(await this.#row(row.id));
  }

  async list() {
    const rows = await this.store.list();

    return create(ui.ListWorkspaceCopyJobsResponseSchema, { jobs: rows.map((row) => this.#message(row)) });
  }

  async cancel(id: string): Promise<ui.WorkspaceCopyJob> {
    const row = await this.#row(id);
    const running = this.#running.get(id);

    if (running) {
      running.reason = "cancel";
      running.stop.abort();
      await running.done;
    } else if (await this.store.status(id, "cancelled", { from: [...OPEN_STATUSES, "failed"] })) {
      await this.#discardTarget(row);
      this.#publish(await this.#row(id));
    }

    return this.#message(await this.#row(id));
  }

  async retry(id: string): Promise<ui.WorkspaceCopyJob> {
    await this.#row(id);

    if (await this.store.status(id, "queued", { from: ["failed", "cancelled"] })) {
      this.#publish(await this.#row(id));
      void this.tick();
    }

    return this.#message(await this.#row(id));
  }

  async dismiss(id: string): Promise<void> {
    const row = await this.#row(id);

    if (!(await this.store.remove(row.id))) throw new InvalidError("Cancel the copy before dismissing it.");
    this.#core.hub.publishOverview(
      create(ui.OverviewUpdateSchema, { change: { case: "workspaceCopyJobRemoved", value: row.id } }),
    );
  }

  /** Starts open jobs up to the limit: after a restart, a worker's return and periodically. */
  async tick(): Promise<void> {
    if (this.#stopped) return;

    try {
      if (this.#ticks++ % 360 === 0) await this.store.prune();

      for (const row of await this.store.open()) {
        if (this.#running.size >= RUNNING) break;

        if (!this.#running.has(row.id)) this.#drive(row);
      }
    } catch (cause) {
      coreLog(this.#core, `workspace copies not resumed: ${describeError(cause)}`);
    }
  }

  #drive(row: JobRow, ready?: PromiseWithResolvers<void>) {
    const running: Running = { stop: new AbortController(), done: Promise.resolve() };
    this.#running.set(row.id, running);
    running.done = this.#run(row, running, ready)
      .catch((cause: unknown) => {
        ready?.reject(cause);
        coreLog(this.#core, `workspace copy ${row.id} stopped: ${describeError(cause)}`);
      })
      .finally(() => {
        ready?.resolve();
        this.#running.delete(row.id);
        this.#live.delete(row.id);
        this.#fresh.delete(row.id);
        void this.tick();
      });
  }

  async #run(row: JobRow, running: Running, ready?: PromiseWithResolvers<void>) {
    let failures = 0;
    // Only the client's own first attempt can be refused outright; later failures are the job's.
    let answered = false;

    for (;;) {
      if (!(await this.store.status(row.id, "copying", { from: [...OPEN_STATUSES] }))) return;
      const live = { row: await this.#row(row.id), currentFile: "" };
      this.#live.set(row.id, live);
      this.#publish(live.row);
      const before = live.row.files;
      const reporter = this.#reporter(live, ready);

      try {
        const result = await copyAttempt(
          this.#core,
          {
            ...this.#ends(row),
            transferKey: row.id,
            parentPath: row.parent_path,
            name: row.name,
            selection: this.#selection(row),
          },
          running.stop.signal,
          reporter.report,
          { keepStaged: true, beforeWrite: (chunks) => this.beforeWrite(row.id, chunks) },
        );

        ready?.resolve();
        await reporter.flush(result);
        await this.store.status(row.id, "completed", { workspaceRef: result.workspaceRef });
        this.#publish(await this.#row(row.id));

        return;
      } catch (error) {
        await reporter.flush();

        if (running.reason === "cancel") return this.#cancelled(row);

        if (running.reason === "shutdown") return;

        answered ||= reporter.started;

        if (ready && !answered) {
          await this.store.status(row.id, "failed", { error: copyMessage(error) });
          await this.store.remove(row.id);
          throw error;
        }

        this.#fresh.delete(row.id);
        failures = live.row.files > before || reporter.progressed ? 0 : failures + 1;

        if (!(await this.#reachable(row))) {
          await this.store.status(row.id, "waiting", {
            error: "Both workers must be online. The copy continues when they are.",
            from: [...OPEN_STATUSES],
          });
          this.#publish(await this.#row(row.id));

          return;
        }

        if (failures >= ATTEMPTS) {
          await this.store.status(row.id, "failed", { error: copyMessage(error), from: [...OPEN_STATUSES] });
          this.#publish(await this.#row(row.id));

          return;
        }

        await abortableSleep(BACKOFF_MS[failures] ?? 5_000, running.stop.signal).catch(() => {});

        if (running.reason === "cancel") return this.#cancelled(row);

        if (running.reason === "shutdown") return;
      }
    }
  }

  /** Throttled progress: published a few times a second, persisted every few seconds. */
  #reporter(live: { row: JobRow; currentFile: string }, ready?: PromiseWithResolvers<void>) {
    let published = 0;
    let persisted = Date.now();
    let first: CopyAttemptProgress | undefined;

    const state = {
      started: false,
      progressed: false,
      report: (progress: CopyAttemptProgress) => {
        first ??= progress;
        state.started = true;
        state.progressed ||= progress.bytes > (first?.bytes ?? 0n);
        ready?.resolve();
        live.row = {
          ...live.row,
          status: progress.status === "finishing" ? "finishing" : "copying",
          bytes: progress.bytes,
          total_bytes: progress.totalBytes,
          files: progress.files,
          total_files: progress.totalFiles,
          skipped: progress.skipped,
        };
        live.currentFile = progress.currentFile;
        const now = Date.now();

        if (now - published >= PUBLISH_MS || progress.status !== "copying") {
          published = now;
          this.#publish(live.row, live.currentFile);
        }

        if (now - persisted >= PERSIST_MS) {
          persisted = now;
          void this.store.progress(live.row.id, progressOf(live.row)).catch(() => {});
        }
      },
      flush: async (done?: CopyAttemptProgress) => {
        if (done) state.report(done);

        if (state.started) await this.store.progress(live.row.id, progressOf(live.row)).catch(() => {});
      },
    };

    return state;
  }

  async #cancelled(row: JobRow) {
    await this.#discardTarget(row);
    await this.store.status(row.id, "cancelled", { from: [...OPEN_STATUSES, "failed"] });
    this.#publish(await this.#row(row.id));
  }

  /** Removes the target's staged files; an offline target removes them itself when its receipt expires. */
  async #discardTarget(row: JobRow) {
    const call = targetCall(this.#core, this.#ends(row), AbortSignal.timeout(15_000));
    await call({ action: { case: "cancel", value: row.id } }).catch(() => {});
  }

  #ends(row: JobRow) {
    return { sourceRef: row.source_ref, targetRef: row.target_ref, projectRef: row.project_ref };
  }

  #selection(row: JobRow): CopySelection {
    return (
      this.#fresh.get(row.id) ?? {
        ignoredHashes: new Set(row.ignored_hashes),
        secretHashes: new Set(row.secret_hashes),
      }
    );
  }

  /** Both ends answer: their workers are connected here, or their linked computers are. */
  async #reachable(row: JobRow) {
    const end = async (ref: string, worker: () => Promise<string>) => {
      const node = splitId(ref).node;

      if (node)
        return peerOf(this.#core, node).then(
          (id) => this.#core.computers?.canCall(id) ?? false,
          () => false,
        );

      return this.#core.link.connections.get(await worker().catch(() => ""))?.isOpen ?? false;
    };

    return (
      (await end(row.target_ref, async () => row.target_ref)) &&
      (await end(row.source_ref, async () => (await ownedCopyWorkspace(this.#core, row.source_ref)).workerId))
    );
  }

  async #workerName(workerId: string) {
    return (await coreWorkers(this.#core).catch(() => [])).find((w) => w.id === workerId)?.name ?? "";
  }

  async #row(id: string) {
    const row = await this.store.get(id);

    if (!row) throw new NotFound("copy not found");

    return row;
  }

  #message(row: JobRow) {
    const live = this.#live.get(row.id);

    return jobMessage(live && OPEN.has(row.status) ? live.row : row, live?.currentFile);
  }

  #publish(row: JobRow, currentFile = "") {
    this.#core.hub.publishOverview(
      create(ui.OverviewUpdateSchema, { change: { case: "workspaceCopyJob", value: jobMessage(row, currentFile) } }),
    );
  }
}

const progressOf = (row: JobRow) => ({
  bytes: row.bytes,
  totalBytes: row.total_bytes,
  files: row.files,
  totalFiles: row.total_files,
  skipped: row.skipped,
});

/** Only messages written for people reach the job; anything else gets a generic line. */
function copyMessage(cause: unknown) {
  const error = unwrap(cause);

  if (error instanceof ConnectError) return error.rawMessage;

  return error instanceof InvalidError ||
    error instanceof NotFound ||
    error instanceof Invalid ||
    error instanceof UnavailableError
    ? error.message
    : "Workspace copy failed. Retry the copy.";
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
