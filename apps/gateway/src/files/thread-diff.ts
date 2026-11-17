import { toBinary } from "@bufbuild/protobuf";
import { ThreadDiffPageSchema, ThreadDiffSnapshotSchema, type ui } from "@canopy/contracts";
import { THREAD_DIFF_CAPABILITY } from "@canopy/domain/release/protocol";
import { DIFF_FILES, DIFF_METADATA_BYTES, DIFF_PAGE_BYTES } from "@canopy/domain/thread-diff-limits";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError, UnavailableError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";

function validPath(path: string) {
  return (
    !!path &&
    path.length <= 4096 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !/^[a-z]:/i.test(path) &&
    !path.split("/").some((part) => !part || [".", "..", ".git"].includes(part))
  );
}

export class ThreadDiff {
  constructor(readonly core: GatewayCore) {}

  async #target(threadId: string) {
    const ownerId = this.core[coreState].options.userId;
    const thread = await coreRun(this.core, (store) => store.thread(threadId));

    if (thread.owner_user_id !== ownerId || thread.deleted_at) throw new InvalidError("Thread unavailable.");

    if (!thread.worker_id || !thread.cwd) throw new InvalidError("This thread has no working directory.");
    const worker = this.core.link.connections.get(thread.worker_id);

    if (!worker?.isOpen) throw new UnavailableError("This computer is offline. Reconnect it to view changes.");

    if (!worker.hello.capabilities.includes(THREAD_DIFF_CAPABILITY))
      throw new InvalidError("Update Canopy on the thread's computer to view changes.");

    return { ownerId, threadId: thread.id, workspace: thread.cwd, workerId: thread.worker_id };
  }

  async list(request: ui.ListThreadDiffRequest) {
    const { workerId, ...target } = await this.#target(request.threadId);
    const result = await coreWorkerQuery(this.core, workerId, { case: "listThreadDiff", value: target }, 35_000);
    const snapshot = result.threadDiff;

    if (
      !snapshot ||
      snapshot.files.length > DIFF_FILES ||
      toBinary(ThreadDiffSnapshotSchema, snapshot).byteLength > DIFF_METADATA_BYTES ||
      snapshot.files.some((file) => !validPath(file.path) || (file.oldPath && !validPath(file.oldPath))) ||
      new Set(snapshot.files.map((file) => file.path)).size !== snapshot.files.length ||
      (snapshot.complete && (!snapshot.snapshotId || snapshot.error))
    )
      throw new InvalidError("Could not load changes. Reload to try again.");

    return snapshot;
  }

  async read(request: ui.ReadThreadDiffRequest) {
    if (!validPath(request.path) || !/^[a-f0-9-]{36}$/.test(request.snapshotId))
      throw new InvalidError("Reload changes to try again.");
    const { workerId, ...target } = await this.#target(request.threadId);
    const limit = Math.max(1, Math.min(request.limit || 128, 200));

    const result = await coreWorkerQuery(
      this.core,
      workerId,
      {
        case: "readThreadDiff",
        value: { ...target, snapshotId: request.snapshotId, path: request.path, offset: request.offset, limit },
      },
      5000,
    );

    const page = result.threadDiffPage;

    if (
      !page ||
      page.lines.length > limit ||
      toBinary(ThreadDiffPageSchema, page).byteLength > DIFF_PAGE_BYTES ||
      page.snapshotId !== request.snapshotId ||
      page.path !== request.path ||
      page.offset !== request.offset ||
      (!page.error && page.lines.length > Math.max(0, page.lineCount - page.offset))
    )
      throw new InvalidError("Could not load changes. Reload to try again.");

    return page;
  }
}
