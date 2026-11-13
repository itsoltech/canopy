import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ThreadFilesUpdateSchema,
  ThreadFileChangeSchema,
  ThreadFileChangeKind as Kind,
  type ui,
  type ThreadFilesUpdate,
} from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { THREAD_FILES_WATCH_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError, UnavailableError } from "../core/core-context.ts";

function safePath(path: string, file = false) {
  return (
    !(file && !path) &&
    path.length <= 4096 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[a-z]:/i.test(path) &&
    !path.split("/").some((part) => ["..", ".", ".git"].includes(part))
  );
}

/** Gateway derives the worker/root and scopes every subscription before it can receive events. */
export class ThreadWatch {
  constructor(readonly core: GatewayCore) {}

  async *watch(request: ui.WatchThreadFilesRequest, signal: AbortSignal): AsyncIterable<ThreadFilesUpdate> {
    if (
      request.directories.length + request.files.length > 32 ||
      request.directories.some((path) => !safePath(path)) ||
      request.files.some((path) => !safePath(path, true)) ||
      request.rootIdentity.length > 64 ||
      request.cursor.length > 128
    )
      throw new InvalidError("Choose up to 32 files and directories inside this thread, then reopen Files.");
    const ownerId = this.core[coreState].options.userId;
    const thread = await coreRun(this.core, (store) => store.thread(request.threadId));

    if (thread.owner_user_id !== ownerId || thread.deleted_at)
      throw new ConnectError("Thread unavailable. Reopen the thread to check access.", Code.PermissionDenied);

    if (!thread.worker_id || !thread.cwd) throw new InvalidError("This thread has no working directory.");
    const worker = this.core.link.connections.get(thread.worker_id);

    if (!worker?.isOpen) throw new UnavailableError("This computer is offline. Reconnect it to watch files.");

    if (!worker.hello.capabilities.includes(THREAD_FILES_WATCH_CAPABILITY))
      throw new ConnectError("Update Canopy on the thread's computer to watch file changes.", Code.Unimplemented);

    if (worker.fileWatches.size >= 32)
      throw new ConnectError("Close unused Files views, then retry.", Code.ResourceExhausted);
    signal.throwIfAborted();
    const subscriptionId = crypto.randomUUID();

    const queue = new AsyncChannel<ThreadFilesUpdate>({
      maxItems: 4,
      maxBytes: 256 * 1024,
      sizeOf: (update) => toBinary(ThreadFilesUpdateSchema, update).byteLength,
      overflow: () =>
        new ConnectError("File changes fell behind. Reopen Files to reload visible items.", Code.ResourceExhausted),
    });

    const command = {
      directories: request.directories,
      files: request.files,
      rootIdentity: request.rootIdentity,
      cursor: request.cursor,
      subscriptionId,
      ownerId,
      threadId: thread.id,
      workspace: thread.cwd,
    };

    const close = () => queue.close();
    signal.addEventListener("abort", close, { once: true });
    worker.fileWatches.set(subscriptionId, (update) => {
      if (!update) {
        close();

        return;
      }

      if (!this.#valid(request, update)) {
        queue.close(new ConnectError("Could not watch file changes. Reload Files.", Code.DataLoss));

        return;
      }

      queue.push(update);
    });

    try {
      const result = await worker.sendCommand({ case: "watchThreadFiles", value: command }, 5000);

      if (!result.ok)
        throw new InvalidError("Could not watch file changes. Collapse unused directories, then reload Files.");

      for await (const update of queue) {
        if (signal.aborted) break;
        const current = await coreRun(this.core, (store) => store.thread(thread.id));

        if (current.owner_user_id !== ownerId || current.deleted_at)
          throw new ConnectError("Thread unavailable. Reopen the thread to check access.", Code.PermissionDenied);

        if (current.cwd !== thread.cwd || current.worker_id !== thread.worker_id) {
          yield {
            ...update,
            changes: [create(ThreadFileChangeSchema, { kind: Kind.ROOT_CHANGED })],
            revalidateRequired: true,
          };

          return;
        }

        yield update;
      }

      if (!signal.aborted) throw new UnavailableError("This computer disconnected. Reconnect it to watch files.");
    } finally {
      signal.removeEventListener("abort", close);
      queue.close();
      worker.fileWatches.delete(subscriptionId);

      if (worker.isOpen)
        await worker
          .sendCommand({ case: "watchThreadFiles", value: { ...command, release: true } }, 5000)
          .catch(() => {});
    }
  }

  #valid(request: ui.WatchThreadFilesRequest, update: ThreadFilesUpdate) {
    return (
      update.rootIdentity.length <= 64 &&
      update.cursor.length <= 128 &&
      update.changes.length <= 64 &&
      toBinary(ThreadFilesUpdateSchema, update).byteLength <= 64 * 1024 &&
      update.changes.every((change) =>
        change.kind === Kind.ROOT_CHANGED
          ? !change.path
          : change.kind === Kind.DIRECTORY_INVALIDATED
            ? request.directories.includes(change.path)
            : (change.kind === Kind.FILE_CHANGED || change.kind === Kind.FILE_REMOVED) &&
              request.files.includes(change.path),
      )
    );
  }
}
