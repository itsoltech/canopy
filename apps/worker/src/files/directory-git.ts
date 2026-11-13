import { processKey, runProcess, withProcessPriority } from "@canopy/process-governor";

export interface DirectoryGit {
  statuses: Map<string, string>;
  complete: boolean;
  reason: string;
}

/** One bounded status per checkout; the governor coalesces concurrent requests. */
export async function directoryGit(root: string): Promise<DirectoryGit> {
  try {
    const signal = AbortSignal.timeout(2000);

    const prefixCommand = {
      argv: ["git", "rev-parse", "--show-prefix"],
      cwd: root,
      timeoutMs: 2000,
      maxBytes: 4096,
      signal,
    };

    const prefixResult = await withProcessPriority("user", () =>
      runProcess(prefixCommand, { kind: "git", key: processKey(prefixCommand), ttlMs: 2000 }),
    );

    if (prefixResult.code !== 0) return { statuses: new Map(), complete: false, reason: "Status unavailable" };
    const prefix = prefixResult.stdout.trimEnd();

    const command = {
      argv: [
        "git",
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--ignored=matching",
        "--untracked-files=normal",
        "--",
        ".",
      ],
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: 2000,
      maxBytes: 1024 * 1024,
      signal,
    };

    const result = await withProcessPriority("user", () =>
      runProcess(command, { kind: "git", key: processKey(command), ttlMs: 2000 }),
    );

    if (result.code !== 0) return { statuses: new Map(), complete: false, reason: "Status unavailable" };
    const statuses = new Map<string, string>();
    const records = result.stdout.split("\0");

    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;

      if (record.length < 4) continue;
      const status = record.slice(0, 2);
      const raw = record.slice(3).replace(/\/$/, "");
      const path = raw.startsWith(prefix) ? raw.slice(prefix.length) : "";

      const value =
        status.includes("U") || status === "AA" || status === "DD"
          ? "U"
          : status === "??"
            ? "?"
            : status === "!!"
              ? "!"
              : status.includes("R")
                ? "R"
                : status.includes("D")
                  ? "D"
                  : status.includes("A")
                    ? "A"
                    : "M";

      if (path) statuses.set(path, value);

      // NUL porcelain places the destination first; the source follows for renames/copies.
      if (status.includes("R") || status.includes("C")) {
        const source = records[++index];

        if (source?.startsWith(prefix)) statuses.set(source.slice(prefix.length), "D");
      }
    }

    return { statuses, complete: true, reason: "" };
  } catch {
    return { statuses: new Map(), complete: false, reason: "Status unavailable" };
  }
}

export function directoryStatus(git: DirectoryGit, path: string, directory: boolean): string {
  const direct = git.statuses.get(path);

  if (direct) return direct;
  const segments = path.split("/");

  for (let end = segments.length - 1; end > 0; end--) {
    const parent = git.statuses.get(segments.slice(0, end).join("/"));

    if (parent === "!" || parent === "?") return parent;
  }

  if (directory)
    for (const [entry, status] of git.statuses)
      if (entry.startsWith(`${path}/`) && status !== "!") return status === "?" ? "?" : "M";

  return "";
}

/** Deleted names share the iterator's metadata budget rather than becoming a second manifest. */
export function directoryDeleted(git: DirectoryGit, directory: string, ignored: boolean) {
  const prefix = directory ? `${directory}/` : "";
  const paths: string[] = [];
  let bytes = 0;

  for (const [path, status] of git.statuses) {
    const name = path.slice(prefix.length);

    if (status !== "D" || !path.startsWith(prefix) || name.includes("/") || (!ignored && name.startsWith(".")))
      continue;
    bytes += new TextEncoder().encode(path).length + 16;

    if (bytes > 128 * 1024) {
      git.complete = false;
      git.reason = "Status unavailable";
      break;
    }

    paths.push(path);
  }

  return paths;
}
