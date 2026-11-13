import { toBinary } from "@bufbuild/protobuf";
import { ThreadFileHighlightSchema, type ui } from "@canopy/contracts";
import { THREAD_FILE_HIGHLIGHT_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError, UnavailableError } from "../core/core-context.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";

/** Owner and thread scope are derived here; no client-selected worker, root or parser code. */
export class ThreadHighlight {
  constructor(readonly core: GatewayCore) {}

  async read(request: ui.ThreadFileHighlightRequest) {
    const { path, sha256, draft } = request;

    if (
      !path ||
      path.startsWith("/") ||
      /^[a-z]:/i.test(path) ||
      path.length > 4096 ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => ["..", ".", ".git"].includes(part)) ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      request.startLine < 1 ||
      request.lineCount < 1 ||
      request.lineCount > 200 ||
      request.draftRevision.length > 64 ||
      (draft !== undefined && (Buffer.byteLength(draft) > 400 * 1024 || !request.draftRevision))
    )
      throw new InvalidError("Open the file again to highlight it.");
    const ownerId = this.core[coreState].options.userId;
    const thread = await coreRun(this.core, (store) => store.thread(request.threadId));

    if (thread.owner_user_id !== ownerId || thread.deleted_at) throw new InvalidError("Thread unavailable.");

    if (!thread.worker_id || !thread.cwd) throw new InvalidError("This thread has no working directory.");
    const worker = this.core.link.connections.get(thread.worker_id);

    if (!worker?.isOpen)
      throw new UnavailableError("This computer is offline. The file remains readable without colors.");

    if (!worker.hello.capabilities.includes(THREAD_FILE_HIGHLIGHT_CAPABILITY))
      throw new InvalidError("Update Canopy on the thread's computer to highlight files.");

    const result = await coreWorkerQuery(
      this.core,
      thread.worker_id,
      {
        case: "getThreadFileHighlight",
        value: {
          ownerId,
          threadId: thread.id,
          workspace: thread.cwd,
          path,
          sha256,
          startLine: request.startLine,
          lineCount: request.lineCount,
          ...(draft !== undefined && { draft }),
          draftRevision: request.draftRevision,
        },
      },
      15_000,
    );

    const page = result.threadFileHighlight;

    if (
      !page ||
      page.sha256 !== sha256 ||
      page.draftRevision !== (draft === undefined ? "" : request.draftRevision) ||
      page.lines.length > request.lineCount ||
      toBinary(ThreadFileHighlightSchema, page).byteLength > 64 * 1024 ||
      page.lines.some(
        (line, index) =>
          line.line < request.startLine ||
          line.line >= request.startLine + request.lineCount ||
          (index > 0 && line.line <= (page.lines[index - 1]?.line ?? 0)) ||
          line.spans.some(
            (span, i) =>
              span.role < 1 ||
              span.role > 12 ||
              span.from >= span.to ||
              span.to > 2000 ||
              (i > 0 && span.from < (line.spans[i - 1]?.to ?? 0)),
          ),
      )
    )
      throw new InvalidError("Highlighting is unavailable. The file remains readable.");

    return page;
  }
}
