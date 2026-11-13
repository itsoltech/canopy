import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ListThreadDirectory } from "@canopy/contracts";
import { ThreadDirectories } from "../../apps/worker/src/files/thread-directory.ts";

/** Uses the real bounded worker enumerator against disposable fixture files. */
export function workspaceDirectory(files: ReadonlyMap<string, Uint8Array>) {
  const temp = process.env["TMPDIR"];

  if (!temp || !temp.startsWith("/")) throw new Error("Set a private TMPDIR for the workspace fixture.");
  const root = join(temp, "workspace-files");
  mkdirSync(join(root, "many"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });

  for (const [name, bytes] of files) writeFileSync(join(root, name), bytes);
  writeFileSync(join(root, "src", "nested.ts"), "export const nested = true;\n");

  for (let index = 0; index < 10_000; index++)
    writeFileSync(join(root, "many", `${String(index).padStart(5, "0")}-${"long-file-name-".repeat(8)}.ts`), "");
  const directories = new ThreadDirectories();

  return (request: ListThreadDirectory) => directories.list({ ...request, workspace: root });
}
