import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { REVEAL_PATH_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { coreUiThread } from "../core/core-titles.ts";
import { branchSwitchReason, listCheckoutBranches, switchCheckoutBranch } from "./branch-checkout.ts";

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

  async switch(request: ui.SwitchThreadBranchRequest): Promise<ui.SwitchThreadBranchResponse> {
    const thread = await this.#thread(request.threadId);
    const detail = await switchCheckoutBranch(this.core, thread, request);

    return create(ui.SwitchThreadBranchResponseSchema, {
      thread: coreUiThread(this.core, await this.#thread(thread.id)),
      detail,
    });
  }
}
