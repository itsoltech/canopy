import { FileResolution, type Command, type FileRequest } from "@canopy/contracts";
import { deleteThreadFile, readThreadFile, resolveThreadFile, writeThreadFile } from "../files/thread-files.ts";
import { resolvePreview } from "../files/resolve-preview.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { openInDefaultApp, revealFileInFileManager } from "./reveal.ts";
import { fileImageMetadata } from "../files/file-image.ts";
import { checkFileRoot } from "../files/file-root.ts";
import { readThreadFileChunk } from "../files/thread-file-download.ts";
import { isAbsolute } from "node:path";
import { isWithin } from "../git/worktrees.ts";

type FileCommand = Extract<
  Command["kind"],
  { case: "readFile" | "openFile" | "revealFile" | "writeFile" | "deleteFile" }
>;

export const isFileCommand = (kind: Command["kind"]): kind is FileCommand =>
  kind.case === "readFile" ||
  kind.case === "openFile" ||
  kind.case === "revealFile" ||
  kind.case === "writeFile" ||
  kind.case === "deleteFile";

/**
 * Files the thread's owner opens from the UI (capability thread_files_v1, docs/protocol.md). The gateway names the
 * thread's directory as its root; the thread's attachments are this worker's own. Read previews also permit
 * files outside the workspace when the worker account can read them; other actions keep the root boundary.
 */
export async function runFileCommand(ctx: HostContext, kind: FileCommand): Promise<CommandOutput> {
  const target: FileRequest | undefined = kind.case === "writeFile" ? kind.value.target : kind.value;

  if (!target) return {};
  const workspace = target.workspace || target.roots[0] || "";
  const rootIdentity = checkFileRoot(workspace, target.expectedRootIdentity);
  const download = kind.case === "readFile" ? target.downloadRange : undefined;

  if (download?.expectedRevision) return { file: await readThreadFileChunk(target.path, rootIdentity, download) };

  const extraRoots = [ctx.state.files.threadDir(target.threadId)];

  // An absolute attachment path is checked against this thread's own attachment root below.
  const revealPreview =
    kind.case === "revealFile" && (!isAbsolute(target.path) || isWithin(target.workspace, target.path));

  const resolution =
    target.workspace && (kind.case === "readFile" || kind.case === "openFile" || revealPreview)
      ? await resolvePreview(target, extraRoots, kind.case === "readFile" ? "readable" : "workspace")
      : undefined;

  if (resolution && resolution.resolution !== FileResolution.FOUND) {
    if (kind.case === "revealFile")
      throw new CommandError(
        "FILE_NOT_RESOLVED",
        "Choose a single existing file in this workspace, then try again.",
        true,
      );

    return { file: resolution };
  }

  const path = resolution?.path || resolveThreadFile(target, extraRoots);
  checkFileRoot(workspace, rootIdentity);

  if (download) return { file: await readThreadFileChunk(path, rootIdentity, download) };

  switch (kind.case) {
    case "readFile":
      return {
        file: await fileImageMetadata({
          ...readThreadFile(path, target.maxBytes, target.includeBinary),
          ...resolution,
          rootIdentity,
        }),
      };
    case "openFile":
      await openInDefaultApp(path);

      return {};
    case "revealFile":
      await revealFileInFileManager(path);

      return {};
    case "writeFile":
      return { file: { ...writeThreadFile(path, kind.value.content, target.expectedSha256), rootIdentity } };
    case "deleteFile":
      deleteThreadFile(path, target.expectedSha256);

      return {};
  }
}
