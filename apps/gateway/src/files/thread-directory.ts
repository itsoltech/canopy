import { toBinary } from "@bufbuild/protobuf";
import { ThreadDirectoryPageSchema, type ui } from "@canopy/contracts";
import { THREAD_DIRECTORY_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError, UnavailableError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";

/** The caller names a thread, never a worker, root or arbitrary filesystem scope. */
export class ThreadDirectory {
  constructor(readonly core: GatewayCore) {}

  async list(request: ui.ListThreadDirectoryRequest) {
    const { directory, pageToken, knownRevision } = request;

    if (
      directory.length > 4096 ||
      directory.includes("\0") ||
      directory.includes("\\") ||
      directory.startsWith("/") ||
      /^[a-z]:/i.test(directory) ||
      directory.split("/").some((part) => part === ".." || part === "." || part === ".git")
    )
      throw new InvalidError("Use a directory inside this thread's working directory, then reload.");

    if (pageToken.length > 64 || knownRevision.length > 64)
      throw new InvalidError("This directory's page expired. Reload the directory.");
    const ownerId = this.core[coreState].options.userId;
    const thread = await coreRun(this.core, (store) => store.thread(request.threadId));

    if (thread.owner_user_id !== ownerId || thread.deleted_at) throw new InvalidError("Thread unavailable.");

    if (!thread.worker_id || !thread.cwd) throw new InvalidError("This thread has no working directory.");
    const worker = this.core.link.connections.get(thread.worker_id);

    if (!worker?.isOpen) throw new UnavailableError("This computer is offline. Reconnect it to browse files.");

    if (!worker.hello.capabilities.includes(THREAD_DIRECTORY_CAPABILITY))
      throw new InvalidError("Update Canopy on the thread's computer to browse files.");

    const result = await coreWorkerQuery(
      this.core,
      thread.worker_id,
      {
        case: "listThreadDirectory",
        value: {
          ownerId,
          threadId: thread.id,
          workspace: thread.cwd,
          directory,
          pageSize: Math.max(1, Math.min(request.pageSize || 100, 200)),
          pageToken,
          knownRevision,
          includeIgnored: request.includeIgnored,
          release: request.release,
        },
      },
      5000,
    );

    const page = result.threadDirectory;

    if (!page || page.entries.length > 200 || toBinary(ThreadDirectoryPageSchema, page).byteLength > 64 * 1024)
      throw new InvalidError("Could not load this directory. Reload it to try again.");
    const normalized = directory.split("/").filter(Boolean).join("/");

    if (
      !page.error &&
      !request.release &&
      (page.directory !== normalized ||
        page.entries.some(
          (entry) =>
            !entry.name ||
            entry.name === "." ||
            entry.name === ".." ||
            entry.name.includes("/") ||
            entry.name.includes("\\") ||
            entry.name.includes("\0") ||
            entry.path !== (normalized ? `${normalized}/${entry.name}` : entry.name),
        ))
    )
      throw new InvalidError("Could not load this directory. Reload it to try again.");

    return page;
  }
}
