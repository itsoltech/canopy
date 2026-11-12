import { create } from "@bufbuild/protobuf";
import { ui, type CommandResult } from "@canopy/contracts";
import { THREAD_FILES_CAPABILITY, THREAD_FILE_PREVIEW_CAPABILITY } from "@canopy/domain/release/protocol";
import { joinThreadPath } from "@canopy/domain/thread-files";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError, UnavailableError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { referencePaths } from "./reference-paths.ts";

const TIMEOUT_MS = 30_000;

/** The worker's FileContent as the UI's ThreadFile (the same fields). */
const threadFile = ({ file }: CommandResult): ui.ThreadFile =>
  file
    ? create(ui.ThreadFileSchema, {
        path: file.path,
        content: file.content,
        size: file.size,
        sha256: file.sha256,
        modifiedMs: file.modifiedMs,
        binary: file.binary,
        truncated: file.truncated,
        relativePath: file.relativePath,
        mimeType: file.mimeType,
        matches: file.matches,
        searchedPaths: file.searchedPaths,
        searchIncomplete: file.searchIncomplete,
        resolution: file.resolution,
      })
    : create(ui.ThreadFileSchema);

/** Upper bound of an edited file: the viewer's read limit (larger files open read-only). */
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

/**
 * Files of a thread (docs/protocol.md, thread_files_v1): the owner opens, edits, deletes or hands a file to its
 * default app. The gateway names the roots (the thread's directory and the owner's workspaces on its worker);
 * the worker resolves symlinks and refuses anything outside them, or the thread's own attachments.
 */
export class ThreadFiles {
  constructor(readonly core: GatewayCore) {}

  async #target(threadId: string, path: string) {
    const owner = this.core[coreState].options.userId;
    const thread = await coreRun(this.core, (s) => s.thread(threadId));

    if (thread.owner_user_id !== owner || thread.deleted_at) throw new InvalidError("Thread unavailable.");

    if (!thread.worker_id || !thread.cwd) throw new InvalidError("This thread has no working directory.");
    const connection = this.core.link.connections.get(thread.worker_id);

    if (!connection?.isOpen) throw new UnavailableError("This computer is offline. Reconnect it to open files.");

    if (!connection.hello.capabilities.includes(THREAD_FILES_CAPABILITY))
      throw new InvalidError("Update this computer to open files from Canopy.");

    if (!path.trim() || path.length > 4096 || path.includes("\0") || path.split(/[\\/]/).includes(".."))
      throw new InvalidError("Use a path inside this workspace, then reload.");

    return {
      workerId: thread.worker_id,
      cwd: thread.cwd,
      preview: connection.hello.capabilities.includes(THREAD_FILE_PREVIEW_CAPABILITY),
      request: {
        threadId: thread.id,
        path: joinThreadPath(thread.cwd, path),
        roots: [thread.cwd],
      },
    };
  }

  async #query(workerId: string, kind: Parameters<typeof coreWorkerQuery>[2]): Promise<CommandResult> {
    return coreWorkerQuery(this.core, workerId, kind, TIMEOUT_MS);
  }

  async read(request: ui.ThreadFileRequest): Promise<ui.ThreadFile> {
    const target = await this.#target(request.threadId, request.path);
    const preferredPaths = target.preview
      ? await referencePaths(this.core, request.threadId, request.itemId, request.path)
      : [];
    const result = await this.#query(target.workerId, {
      case: "readFile",
      value: {
        ...target.request,
        ...(target.preview && { path: request.path, workspace: target.cwd, preferredPaths, includeBinary: true }),
        expectedSha256: request.expectedSha256,
      },
    });
    const file = threadFile(result);
    file.computer = this.core.computers?.hello().name ||
      (await coreRun(this.core, (s) => s.listWorkers(this.core.online))).find((w) => w.id === target.workerId)?.name || "";

    return file;
  }

  async write(request: ui.WriteThreadFileRequest): Promise<ui.ThreadFile> {
    if (request.content.length > MAX_WRITE_BYTES) throw new InvalidError("This file is too large to save from Canopy.");
    const target = await this.#target(request.threadId, request.path);

    return threadFile(
      await this.#query(target.workerId, {
        case: "writeFile",
        value: { target: { ...target.request, expectedSha256: request.expectedSha256 }, content: request.content },
      }),
    );
  }

  async delete(request: ui.ThreadFileRequest): Promise<void> {
    const target = await this.#target(request.threadId, request.path);

    await this.#query(target.workerId, {
      case: "deleteFile",
      value: { ...target.request, expectedSha256: request.expectedSha256 },
    });
  }

  async open(request: ui.ThreadFileRequest): Promise<void> {
    const target = await this.#target(request.threadId, request.path);
    await this.#query(target.workerId, { case: "openFile", value: target.request });
  }
}
