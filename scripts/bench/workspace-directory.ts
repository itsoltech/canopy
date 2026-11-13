import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ListThreadDirectory, ThreadFilesWatch, ThreadFilesUpdate } from "@canopy/contracts";
import { ThreadDirectories } from "../../apps/worker/src/files/thread-directory.ts";
import { ThreadFilesWatcher } from "../../apps/worker/src/files/thread-watch.ts";

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
  const watcher = new ThreadFilesWatcher();

  return {
    list: (request: ListThreadDirectory) => directories.list({ ...request, workspace: root }),
    watch: (request: ThreadFilesWatch, send: (update: ThreadFilesUpdate) => void) =>
      watcher.watch({ ...request, workspace: root }, send),
    read: (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : undefined),
    write: (path: string, bytes: Uint8Array) => writeFileSync(join(root, path), bytes),
    remove: (path: string) => unlinkSync(join(root, path)),
    close: async () => {
      watcher.close();
      await directories.close();
    },
  };
}
