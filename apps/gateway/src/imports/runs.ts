import { create } from "@bufbuild/protobuf";
import { ui, type ImportThreadSummary } from "@canopy/contracts";
import { InvalidError, violates } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { ThreadContinued } from "./append.ts";
import { historyBytes } from "./candidates.ts";
import type { CliImports } from "./index.ts";
import { directoryTargets, newItems, selected, type Scratch } from "./plan.ts";
import type { ImportRunner } from "./runner.ts";
import { createRun, items, knownSources, runs, toUiRun, type KnownSourceRow, type NewItem } from "./store.ts";
import { cancelRun, releaseDeleted, resumeRun, undoRun } from "./transitions.ts";

/**
 * Import runs on the gateway (docs/import.md, "Przebieg"): StartImport turns a scan selection into a run, the runner
 * imports it, and the owner can watch, cancel, resume (failed threads again, a paused run at once) or undo it.
 */
export class ImportRuns {
  readonly #imports: CliImports;
  readonly #runner: ImportRunner;
  readonly #ownerId: () => string;

  constructor(imports: CliImports, runner: ImportRunner, ownerId: () => string) {
    this.#imports = imports;
    this.#runner = runner;
    this.#ownerId = ownerId;
  }

  async start(request: ui.StartImportRequest): Promise<ui.ImportRun> {
    const stored = this.#imports.stored(request.scanId);
    const worker = await this.#imports.worker(stored.workerId);
    const ownerId = this.#ownerId();
    const chosen = selected(stored.scan.threads, request.selection);

    if (chosen.length === 0) throw new InvalidError("Choose at least one thread to import.");
    await this.#imports.sql((sql) => releaseDeleted(sql, ownerId, worker.id));

    const known = new Map(
      (await this.#imports.sql((sql) => knownSources(sql, ownerId, worker.id))).map((k) => [
        `${k.root_id}:${k.agent_cli}:${k.native_id}`,
        k,
      ]),
    );

    const keyOf = (t: ImportThreadSummary) => `${t.rootId}:${t.agentCli}:${t.nativeId}`;
    const fresh = chosen.filter((t) => !known.has(keyOf(t)));

    // Imported, untouched in Canopy, and the CLI added turns since: the same thread gets them.
    const grown = chosen.flatMap((t) => {
      const k = known.get(keyOf(t));

      return k && k.status === "done" && k.thread_id && !k.own_turns && historyBytes(t) > BigInt(k.bytes_done)
        ? [appendItem(t, k)]
        : [];
    });

    if (fresh.length === 0 && grown.length === 0) throw new InvalidError("These threads are already imported.");
    const context = await this.#imports.context(stored);
    const directories = new Map(fresh.map((t) => [t.cwd, t.cwdExists]));

    const targets = await directoryTargets(this.#imports.core, worker.id, directories, request.mappings, context, () =>
      this.#scratch(worker.id),
    );

    const mode = request.mode === "history" ? "history" : "continue";
    const planned: NewItem[] = [...newItems(fresh, targets, mode), ...grown];

    if (planned.length === 0) throw new InvalidError("Every chosen directory is skipped. Choose a target for one.");
    const id = Bun.randomUUIDv7();

    try {
      await this.#imports.sql((sql) =>
        createRun(sql, {
          id,
          ownerId,
          workerId: worker.id,
          mode,
          alreadyImported: chosen.length - fresh.length - grown.length,
          items: planned,
        }),
      );
    } catch (cause) {
      if (violates(cause, "import_runs_active"))
        throw new InvalidError(`An import is already running on ${worker.name}. Wait for it, or cancel it.`);

      if (violates(cause, "import_items_source"))
        throw new InvalidError("Some of these threads are being imported already. Scan again.");
      throw cause;
    }

    void this.#runner.drive(id);

    return this.get(create(ui.ImportRunRequestSchema, { runId: id }));
  }

  async list(): Promise<ui.ListImportRunsResponse> {
    const rows = await this.#imports.sql((sql) => runs(sql, this.#ownerId()));

    return create(ui.ListImportRunsResponseSchema, { runs: rows.map((r) => toUiRun(r)) });
  }

  async get(request: ui.GetImportRunRequest | ui.ImportRunRequest): Promise<ui.ImportRun> {
    const run = (await this.#imports.sql((sql) => runs(sql, this.#ownerId(), checkedId(request.runId))))[0];

    if (!run) throw new InvalidError("Import not found");
    const withItems = "items" in request && request.items;

    return toUiRun(run, withItems ? await this.#imports.sql((sql) => items(sql, run.id)) : []);
  }

  async cancel(request: ui.ImportRunRequest): Promise<ui.ImportRun> {
    const run = await this.get(request);

    if (run.status === "running" || run.status === "paused") {
      const removed = await this.#imports.sql((sql) => cancelRun(sql, this.#ownerId(), run.id));

      if (removed.length > 0) await this.#imports.core.threadsChanged(removed);
    }

    return this.get(request);
  }

  async resume(request: ui.ImportRunRequest): Promise<ui.ImportRun> {
    const run = await this.get(request);

    if (!["paused", "completed", "failed"].includes(run.status)) return run;
    await this.#imports.worker(run.workerId);

    // The state is checked again with the run locked: a Cancel or Undo that got there first stays.
    if (await this.#imports.sql((sql) => resumeRun(sql, this.#ownerId(), run.id))) void this.#runner.drive(run.id);

    return this.get(request);
  }

  /** Deletes the run's threads (the usual soft delete); a running run is cancelled first. */
  async undo(request: ui.ImportRunRequest): Promise<ui.ImportRun> {
    let run = await this.get(request);

    if (run.status === "undone") return run;

    if (run.status === "running" || run.status === "paused") run = await this.cancel(request);
    await this.#runner.drive(run.id);

    // The run is undone in one transaction first (nothing can resume it after): threads it appended to go back to
    // what the earlier import left, or nothing changes when one went on after it. Then the threads it created go.
    const undone = await this.#imports
      .sql((sql) => undoRun(sql, this.#ownerId(), run.id))
      .catch((cause: unknown) => {
        throw cause instanceof ThreadContinued ? new InvalidError(cause.message) : cause;
      });

    if (undone.undone) await this.#removeCopies(run.id, run.workerId);

    for (const threadId of undone.created) await this.#imports.core.deleteThread(threadId);

    if (undone.reverted.length > 0) await this.#imports.core.threadsChanged(undone.reverted);

    return this.get(request);
  }

  /**
   * The private copies native threads resumed from; a thread that took turns in Canopy keeps its copy (restoring
   * the deleted thread continues it). Best effort: an offline worker keeps them in its private home.
   */
  async #removeCopies(runId: string, workerId: string): Promise<void> {
    const copies = await this.#imports.sql(
      (sql) => sql<{ agent_cli: string; provider_thread_id: string; provider_profile_id: string | null }>`
        SELECT ti.agent_cli, t.provider_thread_id, t.provider_profile_id FROM import_items i
          JOIN thread_imports ti ON ti.thread_id = i.thread_id JOIN threads t ON t.id = i.thread_id
         WHERE i.run_id = ${runId}::uuid AND i.base IS NULL AND t.provider_thread_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.trigger <> 'import')`,
    );

    for (const copy of copies) {
      await coreWorkerQuery(
        this.#imports.core,
        workerId,
        {
          case: "removeImportedCopy",
          value: {
            agentCli: copy.agent_cli,
            profileId: copy.provider_profile_id ?? "",
            sessionId: copy.provider_thread_id,
          },
        },
        30_000,
      ).catch(() => undefined);
    }
  }

  /** This worker's place for threads without a project (Hello.scratch_root). */
  async #scratch(workerId: string): Promise<Scratch> {
    const ownerId = this.#ownerId();

    const rows = await this.#imports.sql(
      (sql) => sql<{ id: string; project_id: string }>`
        SELECT pw.id, pw.project_id FROM project_workspaces pw JOIN projects p ON p.id = pw.project_id
         WHERE p.kind = 'scratch' AND p.owner_user_id = ${ownerId}::uuid AND pw.worker_id = ${workerId}::uuid
           AND pw.archived_at IS NULL LIMIT 1`,
    );

    const place = rows[0];

    if (!place) throw new InvalidError("This worker has no place for threads without a project. Update the worker.");

    return { projectId: place.project_id, workspaceId: place.id };
  }
}

function appendItem(t: ImportThreadSummary, k: KnownSourceRow): NewItem {
  return {
    agentCli: t.agentCli,
    rootId: t.rootId,
    nativeId: t.nativeId,
    sourceKey: t.sourceKey,
    title: t.title || t.preview,
    cwd: t.cwd,
    snapshot: {
      size: String(t.snapshot?.size ?? 0n),
      modifiedMs: String(t.snapshot?.modifiedMs ?? 0n),
      prefixSha256: t.snapshot?.prefixSha256 ?? "",
    },
    target: k.target,
    bytes: t.bytes,
    continues: { itemId: k.id, threadId: k.thread_id ?? "", cursor: k.cursor, bytesDone: k.bytes_done },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedId(id: string): string {
  if (!UUID.test(id)) throw new InvalidError("Import not found");

  return id;
}
