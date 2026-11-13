import { createHash } from "node:crypto";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { FileRequestSchema, ThreadFileHighlightSchema, type GetThreadFileHighlight } from "@canopy/contracts";
import { readThreadFile, resolveThreadFile } from "./thread-files.ts";
import { CommandError } from "../runtime/host-types.ts";
import { HighlightPool } from "./highlight-pool.ts";

export class ThreadHighlights {
  readonly #pool = new HighlightPool();

  close() {
    this.#pool.close();
  }

  async read(request: GetThreadFileHighlight) {
    const { path, workspace, sha256, draft } = request;

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
      (draft !== undefined &&
        (Buffer.byteLength(draft) > 400 * 1024 || !request.draftRevision || request.draftRevision.length > 64))
    )
      throw new CommandError("HIGHLIGHT_INVALID", "Open the file again to highlight it.", true);
    const real = resolveThreadFile(create(FileRequestSchema, { path: join(workspace, path), roots: [workspace] }), []);
    const file = readThreadFile(real, 2 * 1024 * 1024);

    if (file.binary || file.truncated || file.sha256 !== sha256)
      throw new CommandError(
        "FILE_CHANGED",
        "The file changed on disk. Reload it to highlight the current version.",
        true,
      );
    const source = draft ?? new TextDecoder().decode(file.content);

    const key = createHash("sha256")
      .update(
        JSON.stringify([request.ownerId, request.threadId, workspace, real, sha256, request.draftRevision, source]),
      )
      .digest("hex");

    const result = create(ThreadFileHighlightSchema, {
      ...(await this.#pool.run({ key, path, source, start: request.startLine, count: request.lineCount })),
      sha256,
      draftRevision: draft === undefined ? "" : request.draftRevision,
    });

    if (toBinary(ThreadFileHighlightSchema, result).byteLength > 64 * 1024)
      throw new CommandError(
        "HIGHLIGHT_LIMIT",
        "This window is shown as plain text to keep the file responsive.",
        true,
      );

    return result;
  }
}
