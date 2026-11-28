import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { coreState, describeError, InvalidError, UnavailableError } from "../core/core-context.ts";
import { coreBroadcastThread, coreLog } from "../core/core-broadcast.ts";
import { coreWorkers } from "../core/core-providers.ts";
import { Invalid, NotFound } from "../store/errors.ts";
import { CheckoutWrites, checkoutMoving } from "./fences.ts";
import { planTransfer } from "./preview.ts";
import { cleanUpTransfer, prepareTransfer } from "./runner.ts";
import {
  abortTransfer,
  cleanedUp,
  commitTransfer,
  finishTransfer,
  freezeTransfer,
  loadTransfer,
  unfinishedTransfers,
  type TransferRow,
} from "./store.ts";
import { transferOperation } from "./worker-io.ts";

/**
 * Moving a thread with its harness session and working tree changes to another worker of this gateway
 * (docs/thread-transfers.md). One durable record per move; preparation runs in the background, the commit is one
 * transaction, and a restart rolls back what did not commit and finishes what did.
 */

const RELEASE_INTERVAL_MS = 30_000;
const STRANDED_MS = 2 * 60_000;

export class ThreadTransfers {
  /** Canopy's own writes into checkouts, fenced while a move reads them (both move paths use it). */
  readonly writes = new CheckoutWrites(
    (workerId, path, os) => this.core[coreState].actions.run(checkoutMoving(this.#owner, workerId, path, os)),
    (workerId) => this.core.link.connections.get(workerId)?.hello.host?.os ?? "",
  );

  readonly #running = new Map<string, AbortController>();
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly core: GatewayCore) {}

  get #owner() {
    return this.core[coreState].options.userId;
  }

  async preview(request: ui.ThreadTransferPreviewRequest) {
    return (await planTransfer(this.core, request.threadId, request.workerId)).preview;
  }

  async start(request: ui.StartThreadTransferRequest): Promise<ui.ThreadTransfer> {
    const plan = await planTransfer(this.core, request.threadId, request.workerId);
    const { preview } = plan;

    if (preview.blocked) throw new InvalidError(preview.blocked);

    if (!preview.workspaceIds.includes(request.workspaceId))
      throw new InvalidError("Choose a workspace of this project on the target worker.");

    if (request.expectedHead && request.expectedHead !== preview.head)
      throw new InvalidError("The thread's checkout changed. Review the move again.");
    const offered = new Map(preview.localFiles.map((f) => [f.path, f]));
    const confirmed = new Set(request.confirmedSecrets);

    for (const path of request.localFiles) {
      const file = offered.get(path);

      if (!file) throw new InvalidError("A chosen local file is no longer available. Review the move again.");

      if (file.secret && !confirmed.has(path))
        throw new InvalidError("Confirm the local files that can contain secrets before moving them.");
    }

    const id = Bun.randomUUIDv7();
    await this.core[coreState].actions.run(
      freezeTransfer({
        owner_user_id: this.#owner,
        id,
        thread_id: request.threadId,
        family: plan.family,
        source_worker_id: plan.source.id,
        target_worker_id: plan.target.id,
        source_workspace_id: plan.sourceWorkspaceId,
        target_workspace_id: request.workspaceId,
        source_cwd: plan.sourceCwd,
        source_worktree_id: plan.sourceWorktreeId,
        sessions: plan.sessions,
        local_files: [...request.localFiles],
        expected_head: preview.head,
        branch: preview.branch,
      }),
    );

    // Launched before anything else can fail; the periodic tick rolls back a preparation nobody runs.
    this.#launch(id);

    for (const threadId of plan.family) await coreBroadcastThread(this.core, threadId).catch(() => undefined);

    return this.get({ id });
  }

  async get(request: { id: string }): Promise<ui.ThreadTransfer> {
    const row = await this.core[coreState].actions.run(loadTransfer(this.#owner, request.id));

    if (!row) throw new NotFound("move not found");

    return toUi(row);
  }

  /** After a restart: preparations roll back, committed moves release their packages. */
  resume(): void {
    void this.#recover().catch((cause: unknown) => coreLog(this.core, `thread transfers: ${describeError(cause)}`));
    this.#timer ??= setInterval(() => void this.#release().catch(() => undefined), RELEASE_INTERVAL_MS);
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;

    for (const controller of this.#running.values()) controller.abort();
  }

  async #recover() {
    for (const row of await this.core[coreState].actions.run(unfinishedTransfers(this.#owner))) {
      if (this.#running.has(row.id)) continue;

      if (row.state === "preparing" || row.state === "prepared")
        await this.#rollBack(row, "The gateway restarted while moving the thread. Nothing was moved.");
      else await this.#finish(row);
    }
  }

  async #release() {
    for (const row of await this.core[coreState].actions.run(unfinishedTransfers(this.#owner))) {
      if (this.#running.has(row.id)) continue;

      // Not run here for a while (a start that never launched): rolled back, never one just being launched.
      if (row.state === "preparing" || row.state === "prepared") {
        if (Date.now() - row.created_at.getTime() > STRANDED_MS)
          await this.#rollBack(row, "Moving the thread stopped. Nothing was moved.");
      } else await this.#finish(row);
    }
  }

  /** What is left after the decision: a committed move releases its packages, an aborted one cleans up. */
  async #finish(row: TransferRow) {
    if (row.state === "committed") await this.#releaseOne(row);
    else if (row.state === "aborted" && row.cleanup_pending && (await cleanUpTransfer(this.core, row)))
      await this.core[coreState].actions.run(cleanedUp(row.id));
  }

  #launch(id: string) {
    const controller = new AbortController();
    this.#running.set(id, controller);
    void this.#perform(id, controller.signal).finally(() => this.#running.delete(id));
  }

  async #perform(id: string, signal: AbortSignal) {
    const load = async () => {
      const row = await this.core[coreState].actions.run(loadTransfer(this.#owner, id));

      if (!row) throw new InvalidError("move not found");

      return row;
    };

    const prepared = await load();
    let release: () => void;

    try {
      // Held until the decision: Canopy saves nothing into the checkout while it moves.
      release = await this.writes.block(prepared.source_worker_id, prepared.source_cwd);
    } catch (error) {
      await this.#rollBack(prepared, failure(error instanceof Error ? error : undefined)).catch(() => undefined);

      return;
    }

    try {
      await this.#prepareAndCommit(id, prepared, signal, load);
    } finally {
      release();
    }
  }

  async #prepareAndCommit(id: string, prepared: TransferRow, signal: AbortSignal, load: () => Promise<TransferRow>) {
    try {
      await prepareTransfer(this.core, prepared, signal);
    } catch (error) {
      await this.#rollBack(await load(), failure(error instanceof Error ? error : undefined)).catch((cause: unknown) =>
        coreLog(this.core, `thread transfer ${id} rollback: ${describeError(cause)}`),
      );

      return;
    }

    const row = await load();

    try {
      const names = await this.#names(row);
      const events = await this.core[coreState].actions.run(commitTransfer(row, names));

      for (const event of events) {
        this.core.githubDetection.request(event.threadId);
        this.core.hub.publishThread(
          event.threadId,
          create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: event.seq, event: event.event } } }),
        );
      }
    } catch (error) {
      await this.#rollBack(row, failure(error instanceof Error ? error : undefined)).catch(() => undefined);

      return;
    } finally {
      for (const threadId of row.family) await coreBroadcastThread(this.core, threadId).catch(() => undefined);
    }

    await this.#releaseOne(await load());
  }

  /**
   * The decision is read back first: a move that committed (even if what followed failed) only goes forward. Otherwise
   * the family is unfrozen, and only then is anything removed from the workers.
   */
  async #rollBack(row: TransferRow, error: string) {
    const run = this.core[coreState].actions.run.bind(this.core[coreState].actions);
    const current = (await run(loadTransfer(this.#owner, row.id))) ?? row;

    if (current.state === "preparing" || current.state === "prepared") {
      await run(abortTransfer(current, error));

      for (const threadId of row.family) await coreBroadcastThread(this.core, threadId).catch(() => undefined);
    }

    const decided = await run(loadTransfer(this.#owner, row.id));

    if (decided) await this.#finish(decided);
  }

  /** Both workers drop the package; the source keeps its copy of the session and files as a backup. */
  async #releaseOne(row: TransferRow) {
    try {
      await transferOperation(this.core, row.target_worker_id, { action: { case: "release", value: row.id } });
      await transferOperation(this.core, row.source_worker_id, { action: { case: "release", value: row.id } });
      await this.core[coreState].actions.run(finishTransfer(row.id));
    } catch {
      // A worker is offline: the next tick tries again.
    }
  }

  async #names(row: TransferRow) {
    const workers = await coreWorkers(this.core);
    const name = (id: string) => workers.find((w) => w.id === id)?.name;

    return {
      from: name(row.source_worker_id) ?? "the previous worker",
      to: name(row.target_worker_id) ?? "this worker",
    };
  }
}

/** A refusal written for the owner, or a general message (worker and database errors are not shown verbatim). */
function failure(error: Error | undefined): string {
  if (error instanceof InvalidError || error instanceof Invalid || error instanceof UnavailableError)
    return error.message;

  if (error instanceof ConnectError) return error.rawMessage;

  return "Moving the thread failed. Nothing was moved.";
}

function toUi(row: TransferRow): ui.ThreadTransfer {
  return create(ui.ThreadTransferSchema, {
    id: row.id,
    threadId: row.thread_id,
    sourceWorkerId: row.source_worker_id,
    targetWorkerId: row.target_worker_id,
    state: row.state,
    phase: row.phase,
    bytes: BigInt(row.bytes),
    totalBytes: BigInt(row.total_bytes),
    error: row.error,
    createdAt: timestampFromDate(row.created_at),
    targetCwd: row.state === "committed" || row.state === "done" ? (row.target_cwd ?? "") : "",
  });
}
