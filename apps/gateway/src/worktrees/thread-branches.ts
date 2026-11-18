import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { threadGitPlacement } from "../store/thread-branches.ts";
import { ui } from "@canopy/contracts";
import { GIT_STATUS_CAPABILITY, REVEAL_PATH_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreWorkerQuery, WorkerQueryError } from "../core/core-mentions.ts";
import { coreUiThread } from "../core/core-titles.ts";
import {
  branchSwitchReason,
  listCheckoutBranches,
  switchCheckoutBranch,
  pullCheckoutOrigin,
} from "./branch-checkout.ts";

export class ThreadBranches {
  constructor(readonly core: GatewayCore) {}

  async #thread(threadId: string) {
    const thread = await coreRun(this.core, (s) => s.thread(threadId));

    if (thread.owner_user_id !== this.core[coreState].options.userId || thread.deleted_at || thread.archived_at)
      throw new InvalidError("Thread unavailable. Open an active thread.");

    if (!thread.worker_id || !thread.cwd) throw new InvalidError("This thread has no working directory.");

    return { ...thread, worker_id: thread.worker_id, cwd: thread.cwd };
  }

  async list(request: ui.ThreadBranchesRequest): Promise<ui.ListGitRefsResponse> {
    const thread = await this.#thread(request.threadId);
    const detail = branchSwitchReason(this.core, thread.worker_id);

    if (detail) return create(ui.ListGitRefsResponseSchema, { detail });

    return listCheckoutBranches(this.core, thread.worker_id, thread.cwd);
  }

  /** Opens the thread's directory in the file manager of its worker's computer. */
  async reveal(request: ui.ThreadBranchesRequest): Promise<void> {
    const thread = await this.#thread(request.threadId);
    const connection = this.core.link.connections.get(thread.worker_id);

    if (!connection?.isOpen) throw new InvalidError("This computer is offline. Reconnect it to open the folder.");

    if (!connection.hello.capabilities.includes(REVEAL_PATH_CAPABILITY))
      throw new InvalidError("Update this computer to open folders from Canopy.");
    await coreWorkerQuery(this.core, thread.worker_id, { case: "revealPath", value: { path: thread.cwd } }, 20_000);
  }

  #gitReason(workerId: string) {
    const connection = this.core.link.connections.get(workerId);

    if (!connection?.isOpen) return "This computer is offline. Reconnect it to use Git actions.";

    if (!connection.hello.capabilities.includes(GIT_STATUS_CAPABILITY))
      return "Update this computer to read changes and pull from origin.";

    return undefined;
  }

  async status(request: ui.ThreadBranchesRequest): Promise<ui.ThreadGitStatusResponse> {
    const state = this.core[coreState];
    const thread = await state.actions.run(threadGitPlacement(state.options.userId, request.threadId));

    if (!thread) throw new ConnectError("Thread unavailable. Open an active thread.", Code.NotFound);

    const unavailable = (detail: string, supported = false) =>
      create(ui.ThreadGitStatusResponseSchema, { detail, supported });

    if (thread.archived) return unavailable("Open an active thread to check local changes.");

    if (thread.removed) return unavailable("This worktree was removed. Continue in a new worktree.");

    if (!thread.worker_id || !thread.cwd) return unavailable("This thread has no working directory.");
    const detail = this.#gitReason(thread.worker_id);

    if (detail) return unavailable(detail);

    try {
      const result = await coreWorkerQuery(
        this.core,
        thread.worker_id,
        {
          case: "getThreadGitStatus",
          value: { threadId: request.threadId, cwd: thread.cwd, expiresAtMs: BigInt(Date.now() + 25_000) },
        },
        30_000,
      );

      return create(ui.ThreadGitStatusResponseSchema, { supported: true, status: result.threadGitStatus });
    } catch (error) {
      if (error instanceof WorkerQueryError) {
        if (["CWD_NOT_FOUND", "CWD_NOT_DIRECTORY"].includes(error.code))
          return unavailable(
            "Canopy could not find the working directory. Check its location on the thread’s computer.",
          );

        if (["STATUS_TOO_LARGE", "GIT_OUTPUT_LIMIT"].includes(error.code))
          return unavailable("These changes are too large to summarize. Check them in your terminal.", true);

        if (["CHECKOUT_BUSY", "GIT_BUSY", "WORKTREE_BUSY"].includes(error.code))
          return unavailable("Git is busy. Refresh in a moment.", true);
      }

      if (
        (error instanceof WorkerQueryError && ["SWITCH_EXPIRED", "GIT_TIMEOUT"].includes(error.code)) ||
        (error instanceof ConnectError && error.code === Code.DeadlineExceeded)
      )
        return unavailable("Checking local changes timed out. Refresh to try again.", true);
      throw error;
    }
  }

  async pull(request: ui.ThreadBranchesRequest): Promise<ui.ThreadGitStatusResponse> {
    const thread = await this.#thread(request.threadId);
    const detail = this.#gitReason(thread.worker_id);

    if (detail) throw new InvalidError(detail);
    const result = await pullCheckoutOrigin(this.core, thread);

    return create(ui.ThreadGitStatusResponseSchema, { supported: true, status: result.threadGitStatus });
  }

  async switch(request: ui.SwitchThreadBranchRequest): Promise<ui.SwitchThreadBranchResponse> {
    const thread = await this.#thread(request.threadId);
    const detail = await switchCheckoutBranch(this.core, thread, request);

    return create(ui.SwitchThreadBranchResponseSchema, {
      thread: coreUiThread(this.core, await this.#thread(thread.id)),
      detail,
    });
  }
}
