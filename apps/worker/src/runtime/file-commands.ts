import type { Command, FileRequest } from "@canopy/contracts";
import { deleteThreadFile, readThreadFile, resolveThreadFile, writeThreadFile } from "../files/thread-files.ts";
import type { CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import { openInDefaultApp } from "./reveal.ts";

type FileCommand = Extract<Command["kind"], { case: "readFile" | "openFile" | "writeFile" | "deleteFile" }>;

export const isFileCommand = (kind: Command["kind"]): kind is FileCommand =>
  kind.case === "readFile" || kind.case === "openFile" || kind.case === "writeFile" || kind.case === "deleteFile";

/**
 * Files the thread's owner opens from the UI (capability thread_files_v1, docs/protocol.md). The gateway names the
 * thread's directory and the owner's workspaces as roots; the thread's attachments are this worker's own.
 */
export async function runFileCommand(ctx: HostContext, kind: FileCommand): Promise<CommandOutput> {
  const target: FileRequest | undefined = kind.case === "writeFile" ? kind.value.target : kind.value;

  if (!target) return {};
  const path = resolveThreadFile(target, [ctx.state.files.threadDir(target.threadId)]);

  switch (kind.case) {
    case "readFile":
      return { file: readThreadFile(path, target.maxBytes) };
    case "openFile":
      await openInDefaultApp(path);

      return {};
    case "writeFile":
      return { file: writeThreadFile(path, kind.value.content, target.expectedSha256) };
    case "deleteFile":
      deleteThreadFile(path, target.expectedSha256);

      return {};
  }
}
