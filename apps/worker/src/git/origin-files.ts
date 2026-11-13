import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Git's --local scope does not follow include/includeIf. Track the repository and linked-worktree files. */
export async function originFiles(cwd: string): Promise<string> {
  for (let directory = resolve(cwd); ;) {
    const marker = join(directory, ".git");
    const entry = await stat(marker).catch(() => undefined);

    if (entry) {
      const pointer = entry.isFile() ? (await readFile(marker, "utf8")).trim() : "";
      const git = entry.isDirectory() ? marker : resolve(directory, pointer.replace(/^gitdir: /, ""));
      const commonFile = join(git, "commondir");
      const common = (await readFile(commonFile, "utf8").catch(() => "")).trim();

      const files = [
        marker,
        commonFile,
        join(common ? resolve(git, common) : git, "config"),
        join(git, "config.worktree"),
      ];

      return (
        await Promise.all(
          files.map(async (file) => {
            const info = await stat(file, { bigint: true }).catch(() => undefined);

            const identity = info ? `${info.dev}:${info.ino}` : "missing";

            return `${file}:${identity}${info && !info.isDirectory() ? `:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : ""}`;
          }),
        )
      ).join("\n");
    }

    const parent = dirname(directory);

    if (parent === directory) return "";
    directory = parent;
  }
}
