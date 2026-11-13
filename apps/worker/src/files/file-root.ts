import { realpathSync, statSync } from "node:fs";
import { directoryIdentity } from "./thread-directory-path.ts";
import { CommandError } from "../runtime/host-types.ts";

export function fileRoot(workspace: string): string {
  if (!workspace) return "";
  const root = realpathSync(workspace);
  const info = statSync(root, { bigint: true });

  return directoryIdentity(`${root}:${info.dev}:${info.ino}:${info.birthtimeNs}`);
}

export function checkFileRoot(workspace: string, expected: string): string {
  const identity = fileRoot(workspace);

  if (expected && identity !== expected)
    throw new CommandError(
      "FILE_CHANGED",
      "The working directory changed. Copy your changes, then reload the file.",
      true,
    );

  return identity;
}
