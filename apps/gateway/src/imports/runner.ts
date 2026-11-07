import { create } from "@bufbuild/protobuf";
import { ImportSnapshotSchema } from "@canopy/contracts";
import { Effect } from "effect";
import type { GatewayCore } from "../core/core.ts";
import { coreLog } from "../core/core-broadcast.ts";
import { coreState, describeError, UnavailableError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { ensureThread, ingestPage } from "./ingest.ts";
import { LibraryApply } from "./library-apply.ts";
import { failLibraryItem, nextLibraryItem, type LibraryRow } from "./library-store.ts";
import { nextItem, runs, type ItemRow } from "./store.ts";
import {
  adoptionFailed,
  failItem,
  finishEmpty,
  finishItem,
  ImportStopped,
  resumePaused,
  runnerRunStatus,
  threadToHistory,
} from "./transitions.ts";

/**
 * Drives import runs (docs/import.md, "Przebieg"): one thread at a time per run, one page at a time per thread,
 * each page committed with its cursor. A worker going away pauses the run; it continues from the cursor when the
 * worker is back (its connection, the periodic check, or Resume). A source that cannot be read fails only its item.
 */

const PAGE_BYTES = 4 * 1024 ** 2;
const PAGE_TIMEOUT_MS = 120_000;
const CHECK_MS = 10_000;

function snapshotOf(item: ItemRow) {
  return create(ImportSnapshotSchema, {
    size: BigInt(item.snapshot.size),
    modifiedMs: BigInt(item.snapshot.modifiedMs),
    prefixSha256: item.snapshot.prefixSha256,
    historySize: BigInt(item.snapshot.historySize ?? "0"),
    historyPrefixSha256: item.snapshot.historyPrefixSha256 ?? "",
  });
}

export class ImportRunner {
  readonly #core: GatewayCore;
  readonly #active = new Map<string, Promise<void>>();
  readonly #sql: <A, E>(use: (sql: import("effect/sql").SqlClient.SqlClient) => Effect.Effect<A, E>) => Promise<A>;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #library: LibraryApply;
  /** Soft size of one page; tests make it tiny to get one turn per page. */
  pageBytes = PAGE_BYTES;
  /** Runs before each page is asked for; tests take the worker away at an exact page with it. */
  beforePage: (item: ItemRow) => void = () => {};

  constructor(
    core: GatewayCore,
    sql: <A, E>(use: (sql: import("effect/sql").SqlClient.SqlClient) => Effect.Effect<A, E>) => Promise<A>,
  ) {
    this.#core = core;
    this.#sql = sql;
    this.#library = new LibraryApply(core, sql);
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), CHECK_MS);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.allSettled(this.#active.values());
  }

  /** Continues runs that are running or paused on connected workers (after a restart or a reconnect). */
  async tick(workerId?: string): Promise<void> {
    const open = await this.#sql(
      (sql) => sql<{ id: string; worker_id: string; status: string }>`
        SELECT id, worker_id, status FROM import_runs
         WHERE status IN ('running', 'paused') AND (${workerId ?? null}::uuid IS NULL OR worker_id = ${workerId ?? null}::uuid)`,
    );

    for (const run of open) {
      if (this.#active.has(run.id) || !this.#core.link.connections.get(run.worker_id)?.isOpen) continue;

      // Only from paused: a run cancelled or undone since the list was read stays so.
      if (run.status === "paused" && !(await this.#sql((sql) => resumePaused(sql, run.id)))) continue;
      void this.drive(run.id);
    }
  }

  /** Runs one import to its end (or until it pauses or is cancelled); concurrent calls share the drive. */
  drive(runId: string): Promise<void> {
    const running = this.#active.get(runId);

    if (running) return running;

    const drive = this.#drive(runId)
      .catch((cause: unknown) => coreLog(this.#core, `import ${runId} stopped: ${describeError(cause)}`))
      .finally(() => this.#active.delete(runId));

    this.#active.set(runId, drive);

    return drive;
  }

  async #drive(runId: string): Promise<void> {
    const ownerId = this.#core[coreState].options.userId;

    for (;;) {
      const run = (await this.#sql((sql) => runs(sql, ownerId, runId)))[0];

      if (!run || run.status !== "running") return;
      // Settings and library first: they are quick, and threads may take long.
      const setting = (await this.#sql((sql) => nextLibraryItem(sql, runId)))[0];

      if (setting) {
        if (!(await this.#applyLibrary(setting, run.worker_name))) return;
        continue;
      }

      const item = (await this.#sql((sql) => nextItem(sql, runId)))[0];

      if (!item) {
        const done = run.done + run.library_done;
        const failed = run.failed + run.library_failed;
        await this.#sql((sql) => runnerRunStatus(sql, runId, done > 0 || failed === 0 ? "completed" : "failed"));

        return;
      }

      try {
        await this.#importItem(item);
      } catch (cause) {
        // Cancelled or undone meanwhile: that path removed what the import wrote.
        if (cause instanceof ImportStopped) continue;

        if (cause instanceof UnavailableError || !this.#core.link.connections.get(item.worker_id)?.isOpen) {
          await this.#sql((sql) =>
            runnerRunStatus(
              sql,
              runId,
              "paused",
              `${run.worker_name} is offline. The import continues when it is back.`,
            ),
          );

          return;
        }

        // A run stopped meanwhile keeps its terminal state; its items are not marked failed.
        const failed = await this.#sql((sql) => failItem(sql, item.id, describeError(cause)));

        if (failed.dropped) await this.#core.threadsChanged([failed.dropped]);
      }
    }
  }

  async #importItem(item: ItemRow): Promise<void> {
    const threadId = await this.#sql((sql) => ensureThread(sql, item, null));
    await this.#core.threadsChanged([threadId]);
    let cursor = item.cursor;

    for (;;) {
      const status = (
        await this.#sql(
          (sql) => sql<{ status: string }>`SELECT status FROM import_runs WHERE id = ${item.run_id}::uuid`,
        )
      )[0]?.status;

      // Stopped: cancelRun (one transaction) already cleaned up; the runner only stops.
      if (status !== "running") return;

      this.beforePage(item);

      const result = await coreWorkerQuery(
        this.#core,
        item.worker_id,
        {
          case: "readImportPage",
          value: {
            sourceKey: item.source_key,
            snapshot: snapshotOf(item),
            cursor,
            threadId,
            maxBytes: this.pageBytes,
          },
        },
        PAGE_TIMEOUT_MS,
      );

      const page = result.importPage;

      if (!page) throw new Error("the worker did not return a page");
      await this.#sql((sql) => ingestPage(sql, item, threadId, page));
      cursor = page.nextCursor;

      if (page.done) {
        // Nothing to import (a session without conversation): no empty thread in the sidebar.
        const empty = await this.#sql((sql) => finishEmpty(sql, item.id, threadId));

        if (empty.empty) {
          if (empty.dropped) await this.#core.threadsChanged([empty.dropped]);

          return;
        }

        const sessionId = item.target.mode === "native" ? await this.#adopt(item, threadId) : "";

        const finished = await this.#sql((sql) =>
          finishItem(sql, item.id, sessionId ? { threadId, sessionId } : undefined),
        );

        // Stopped while its copy grew: the copy is ahead of the timeline the cancellation put back.
        if (!finished && sessionId && item.base !== null)
          await this.#sql((sql) =>
            threadToHistory(sql, threadId, "Continues in a new thread: its CLI copy has turns that were removed."),
          );
        await this.#core.threadsChanged([threadId]);

        return;
      }
    }
  }

  /**
   * Native continue (docs/import.md, "Kontynuacja"): the worker copies the session into the instance's private home
   * and the thread resumes it. When that is not possible the thread stays as history, with the reason (it continues
   * in a new thread). The thread takes turns only once the item is done (finishItem sets its session atomically).
   */
  async #adopt(item: ItemRow, threadId: string): Promise<string> {
    try {
      const result = await coreWorkerQuery(
        this.#core,
        item.worker_id,
        {
          case: "adoptImportedSession",
          value: {
            sourceKey: item.source_key,
            snapshot: snapshotOf(item),
            profileId: "",
            replace: item.status === "importing" && item.bytes_done !== "0",
          },
        },
        PAGE_TIMEOUT_MS,
      );

      return result.importedSessionId;
    } catch (cause) {
      if (cause instanceof UnavailableError) throw cause;
      const reason = `Continues in a new thread: ${describeError(cause)}`;
      await this.#sql((sql) => adoptionFailed(sql, item.id, threadId, reason));

      return "";
    }
  }

  /**
   * One setting or library item (docs/import.md, "Ustawienia i biblioteka"). False when the run pauses (the worker
   * went away while its file was read).
   */
  async #applyLibrary(row: LibraryRow, workerName: string): Promise<boolean> {
    try {
      // The change and its receipt (what Undo needs) commit together, whatever happened to the run meanwhile.
      await this.#library.apply(row);
    } catch (cause) {
      if (cause instanceof UnavailableError || !this.#core.link.connections.get(row.worker_id)?.isOpen) {
        await this.#sql((sql) =>
          runnerRunStatus(sql, row.run_id, "paused", `${workerName} is offline. The import continues when it is back.`),
        );

        return false;
      }

      // Only while the run is running: a cancelled run keeps its items as they are.
      await this.#sql((sql) => failLibraryItem(sql, row, describeError(cause)));
    }

    return true;
  }
}
