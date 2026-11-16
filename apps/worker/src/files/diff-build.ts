import { closeSync, lstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  ThreadDiffFileSchema,
  ThreadDiffLineKind as Kind,
  ThreadDiffLineSchema,
  type ThreadDiffFile,
} from "@canopy/contracts";
import { DIFF_FILES, diffGit, diffGitConfig, DiffLimit, streamDiffGit, type DiffBudget } from "./diff-process.ts";
import { copyDiffSource, diffRefused, validDiffPath } from "./diff-source.ts";
import { DiffSpoolWriter, type DiffSpool } from "./diff-spool.ts";

interface Change {
  path: string;
  oldPath: string;
  status: string;
  oldOid: string;
  oldMode: string;
  newMode: string;
}

function rawChanges(raw: string): Change[] {
  const records = raw.split("\0");
  const changes: Change[] = [];

  for (let index = 0; index < records.length && records[index]; index++) {
    const header = /^:(\d+) (\d+) ([a-f0-9]+) [a-f0-9]+ ([A-Z])\d*$/.exec(records[index]!);

    if (!header) throw new Error("Could not load changes.");
    const first = records[++index] ?? "";
    const status = header[4]!;
    const renamed = status === "R" || status === "C";
    const path = renamed ? (records[++index] ?? "") : first;

    if (!validDiffPath(path) || (renamed && !validDiffPath(first))) throw diffRefused();
    changes.push({
      path,
      oldPath: renamed ? first : "",
      status,
      oldOid: header[3]!,
      oldMode: header[1]!,
      newMode: header[2]!,
    });
  }

  return changes;
}

async function changesAt(root: string, head: string, budget: DiffBudget): Promise<Change[]> {
  let changes: Change[];

  if (head) {
    const raw = await diffGit(
      root,
      [
        "diff",
        "--raw",
        "-z",
        "--relative",
        "--no-abbrev",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        "-l1000",
        head,
        "--",
        ".",
      ],
      budget,
    );

    if (raw.code !== 0) throw new Error("Could not load changes.");
    changes = rawChanges(raw.stdout);
  } else {
    const index = await diffGit(root, ["ls-files", "--stage", "-z", "--", "."], budget);

    if (index.code !== 0) throw new Error("Could not load changes.");
    changes = index.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(\d+) [a-f0-9]+ 0\t([\s\S]+)$/.exec(entry);

        if (!match || !validDiffPath(match[2]!)) throw diffRefused();

        return { path: match[2]!, oldPath: "", status: "A", oldOid: "", oldMode: "000000", newMode: match[1]! };
      });
  }

  const untracked = await diffGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], budget);

  if (untracked.code !== 0) throw new Error("Could not load changes.");

  for (const raw of untracked.stdout.split("\0").filter(Boolean)) {
    // Git reports an embedded repository as a directory; never traverse or copy its contents.
    const embedded = raw.endsWith("/");
    const path = embedded ? raw.slice(0, -1) : raw;

    if (!validDiffPath(path)) throw diffRefused();
    changes.push({
      path,
      oldPath: "",
      status: "?",
      oldOid: "",
      oldMode: "000000",
      newMode: embedded ? "160000" : "100644",
    });
  }

  const unique = new Map<string, Change>();

  for (const change of changes) {
    const previous = unique.get(change.path);

    if (previous && change.status === "?") {
      // An index deletion followed by a new worktree file is one combined modification.
      unique.set(change.path, { ...previous, status: "M", newMode: change.newMode });
    } else if (previous?.status === "U") continue;
    else unique.set(change.path, change);
  }

  const conflicts = await diffGit(root, ["ls-files", "--unmerged", "-z", "--", "."], budget);

  if (conflicts.code !== 0) throw new Error("Could not load changes.");

  for (const entry of conflicts.stdout.split("\0").filter(Boolean)) {
    const path = entry.slice(entry.indexOf("\t") + 1);
    const change = unique.get(path);

    if (change) change.status = "U";
  }

  if (unique.size > DIFF_FILES) throw new DiffLimit();

  return [...unique.values()]
    .filter((change) => {
      if (head || change.status === "D") return true;

      try {
        lstatSync(join(root, change.path));

        return true;
      } catch (cause) {
        // An unborn staged file removed again has no net change against the empty tree.
        if (cause instanceof Error && "code" in cause && ["ENOENT", "ENOTDIR"].includes(String(cause.code)))
          return false;
        throw cause;
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function buildFile(
  root: string,
  directory: string,
  change: Change,
  index: number,
  budget: DiffBudget,
): Promise<DiffSpool> {
  const file = create(ThreadDiffFileSchema, { path: change.path, oldPath: change.oldPath, status: change.status });
  const writer = new DiffSpoolWriter(join(directory, `${index}.lines`), file, budget);
  const old = join(directory, "old");
  const current = join(directory, "current");

  try {
    const deleted = change.status === "D" || change.newMode === "000000";
    const info = deleted ? undefined : lstatSync(join(root, change.path));

    const special =
      [change.oldMode, change.newMode].some((mode) => mode === "120000" || mode === "160000") || info?.isSymbolicLink();

    if (special) {
      file.binary = true;
      writer.append(create(ThreadDiffLineSchema, { kind: Kind.META, text: "Link or submodule changed" }));
    } else {
      await oldSource(root, old, change, budget);

      if (deleted) writeFileSync(current, "", { mode: 0o600 });
      else copyDiffSource(root, change.path, current, budget);

      const code = await streamDiffGit(
        root,
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--unified=3",
          "--line-prefix=",
          "--output-indicator-new=+",
          "--output-indicator-old=-",
          "--output-indicator-context= ",
          "--",
          old,
          current,
        ],
        budget,
        (chunk) => writer.consume(chunk),
      );

      if (code !== 0 && code !== 1) throw new Error("Could not load changes.");
    }

    if (change.status === "U") writer.append(create(ThreadDiffLineSchema, { kind: Kind.META, text: "Merge conflict" }));

    if (change.oldMode !== "000000" && change.newMode !== "000000" && change.oldMode !== change.newMode)
      writer.append(
        create(ThreadDiffLineSchema, {
          kind: Kind.META,
          text: `File mode changed: ${change.oldMode} → ${change.newMode}`,
        }),
      );

    return writer.finish();
  } finally {
    writer.close();

    for (const path of [old, current]) {
      try {
        unlinkSync(path);
      } catch {
        /* A failed source copy may not create both files. */
      }
    }
  }
}

async function oldSource(root: string, target: string, change: Change, budget: DiffBudget) {
  const fd = openSync(target, "wx", 0o600);

  try {
    if (change.oldOid && !/^0+$/.test(change.oldOid)) {
      const code = await streamDiffGit(root, ["cat-file", "blob", change.oldOid], budget, (chunk) => {
        writeFileSync(fd, chunk);
      });

      if (code !== 0) throw new Error("Could not read the previous version.");
    }
  } finally {
    closeSync(fd);
  }
}

export async function buildDiff(root: string, directory: string, budget: DiffBudget) {
  budget.gitConfig = await diffGitConfig(root, budget.signal);
  const repository = await diffGit(root, ["rev-parse", "--show-prefix"], budget);

  if (repository.code !== 0) return undefined;
  const resolved = await diffGit(root, ["rev-parse", "--verify", "HEAD"], budget);
  const head = resolved.code === 0 ? resolved.stdout.trim() : "";
  const changes = await changesAt(root, head, budget);
  const files: ThreadDiffFile[] = [];
  const spools = new Map<string, DiffSpool>();
  let metadataBytes = 1024;

  for (const [index, change] of changes.entries()) {
    budget.signal.throwIfAborted();
    const spool = await buildFile(root, directory, change, index, budget);
    metadataBytes += toBinary(ThreadDiffFileSchema, spool.file).byteLength + 8;

    if (metadataBytes > 512 * 1024) throw new DiffLimit();
    files.push(spool.file);
    spools.set(change.path, spool);
  }

  return { files, spools };
}
