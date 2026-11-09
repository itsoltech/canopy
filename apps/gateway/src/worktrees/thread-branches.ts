import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { GIT_BRANCH_SWITCH_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreRun, coreBroadcastThread } from "../core/core-broadcast.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { coreUiThread } from "../core/core-titles.ts";
import { branchCheckoutPaths, branchSwitchNotices, lockBranchCheckout } from "../store/thread-branches.ts";

export class ThreadBranches {
  constructor(readonly core: GatewayCore) {}

  async #thread(threadId: string) {
    const thread = await coreRun(this.core, (s) => s.thread(threadId));

    if (thread.owner_user_id !== this.core[coreState].options.userId || thread.deleted_at || thread.archived_at)
      throw new InvalidError("Thread unavailable. Open an active thread.");

    if (!thread.worker_id || !thread.cwd) throw new InvalidError("This thread has no working directory.");

    return { ...thread, worker_id: thread.worker_id, cwd: thread.cwd };
  }

  #reason(workerId: string) {
    const connection = this.core.link.connections.get(workerId);

    if (!connection?.isOpen) return "This computer is offline. Reconnect it to switch branches.";

    if (!connection.hello.capabilities.includes(GIT_BRANCH_SWITCH_CAPABILITY))
      return "Update this computer to switch branches.";

    return undefined;
  }

  async list(request: ui.ThreadBranchesRequest): Promise<ui.ListGitRefsResponse> {
    const thread = await this.#thread(request.threadId);
    const detail = this.#reason(thread.worker_id);

    if (detail) return create(ui.ListGitRefsResponseSchema, { detail });

    const result = await coreWorkerQuery(
      this.core,
      thread.worker_id,
      { case: "listGitRefs", value: { repoPath: thread.cwd, branchesOnly: true } },
      30_000,
    );

    return create(ui.ListGitRefsResponseSchema, { supported: Boolean(result.gitRefs?.isRepo), refs: result.gitRefs });
  }

  async switch(request: ui.SwitchThreadBranchRequest): Promise<ui.SwitchThreadBranchResponse> {
    const thread = await this.#thread(request.threadId);
    const detail = this.#reason(thread.worker_id);

    if (detail) throw new InvalidError(detail);
    const actions = this.core[coreState].actions;
    const knownPaths = await actions.run(branchCheckoutPaths(thread.worker_id));

    // A full ref listing is unnecessary here. The worker checks exact refs and a fresh status before mutation.
    const rootResult = await coreWorkerQuery(
      this.core,
      thread.worker_id,
      { case: "listGitRefs", value: { repoPath: thread.cwd, worktreesOnly: true, branchesOnly: true, knownPaths } },
      30_000,
    );

    const root = rootResult.gitRefs?.repoRoot;

    if (!root) throw new InvalidError("This directory is not a git checkout.");

    const stored = await actions.transaction(async () => {
      const ids = await actions.run(
        lockBranchCheckout(this.core[coreState].options.userId, thread, rootResult.gitRefs?.sameCheckoutPaths ?? []),
      );

      if (!ids.includes(thread.id)) throw new InvalidError("The working directory changed. Refresh the thread.");

      const result = await coreWorkerQuery(
        this.core,
        thread.worker_id,
        {
          case: "switchThreadBranch",
          value: {
            threadId: thread.id,
            cwd: thread.cwd,
            branch: request.branch,
            remote: request.remote,
            expiresAtMs: BigInt(Date.now() + 90_000),
          },
        },
        120_000,
      );

      const head = result.switchedHead;

      if (!head?.branch) throw new InvalidError("Could not read the current branch. Refresh the thread.");
      await coreRun(this.core, (s) => s.saveGitHead(thread.worker_id, ids, head));

      return actions.run(branchSwitchNotices(ids, head.branch));
    });

    for (const event of stored) {
      this.core.hub.publishThread(
        event.threadId,
        create(ui.ThreadUpdateSchema, { change: { case: "event", value: { seq: event.seq, event: event.event } } }),
      );
      await coreBroadcastThread(this.core, event.threadId);
    }

    return create(ui.SwitchThreadBranchResponseSchema, {
      thread: coreUiThread(this.core, await this.#thread(thread.id)),
    });
  }
}
