import { create } from "@bufbuild/protobuf";
import {
  WorkspaceCopyEntrySchema,
  WorkspaceCopyManifestSchema,
  type WorkspaceCopyEntry,
  type WorkspaceCopyManifest,
} from "@canopy/contracts";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  COPY_MAX_ENTRIES,
  COPY_MANIFEST_BYTES,
  copyGenerated,
  copyLocalConfig,
  copySecret,
  copySafePath,
} from "@canopy/domain/workspace-copy";
import { freshGit, git } from "../git/git.ts";
import { copyError, within, checkedParent } from "./safety.ts";

export interface ScannedFile {
  root: string;
  path: string;
  size: number;
  mtime: number;
  ino: number;
  dev: number;
}

export interface CopyScan {
  manifest: WorkspaceCopyManifest;
  files: Map<string, ScannedFile>;
}

/** Preview metadata only; ignored dependencies are pruned before walking their contents. */
export async function scanWorkspace(path: string): Promise<CopyScan> {
  const root = await realpath(path);
  const tracked = await freshGit(() => git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));

  if (!tracked.ok) throw copyError("Choose a Git repository to copy.");
  const top = await git(root, ["rev-parse", "--show-toplevel"]);

  if (!top.ok || (await realpath(top.stdout.trim())) !== root) throw copyError("Choose the repository root to copy.");
  const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const worktree = await git(root, ["rev-parse", "--absolute-git-dir"]);

  if (!common.ok || !worktree.ok) throw copyError("Could not read the repository metadata.");
  const customRoot = await git(root, ["config", "--get", "core.worktree"]);

  if (customRoot.ok) throw copyError("Repositories with core.worktree must be cloned instead of copied.");
  const commonRoot = await realpath(common.stdout.trim());
  const gitRoot = await realpath(worktree.stdout.trim());
  const included = new Set(tracked.stdout.split("\0").filter(Boolean));
  const ignored = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);

  if (!ignored.ok) throw copyError("Could not list ignored files. Refresh and retry.");

  const ignoredDirectories = new Set(
    ignored.stdout
      .split("\0")
      .filter((p) => p.endsWith("/"))
      .map((p) => p.slice(0, -1)),
  );

  const entries: WorkspaceCopyEntry[] = [];
  const files = new Map<string, ScannedFile>();
  const requiredDirectories = new Set<string>();

  for (const path of included)
    path
      .split("/")
      .slice(0, -1)
      .forEach((_, i, parts) => requiredDirectories.add(parts.slice(0, i + 1).join("/")));
  const skippedDirectories: string[] = [];

  const context = {
    root,
    included,
    requiredDirectories,
    ignoredDirectories,
    entries,
    files,
    skippedDirectories,
    manifestBytes: 0,
  };

  await walk(context, root, "", "", false);
  await walk(context, commonRoot, "", ".git", true, gitRoot !== commonRoot);

  if (gitRoot !== commonRoot) {
    for (const name of [
      "HEAD",
      "index",
      "config.worktree",
      "ORIG_HEAD",
      "MERGE_HEAD",
      "MERGE_MSG",
      "CHERRY_PICK_HEAD",
      ...(await readdir(gitRoot)).filter((name) => name.startsWith("sharedindex.")),
    ]) {
      if (!(await lstat(join(gitRoot, name)).catch(() => undefined))) continue;
      const index = entries.findIndex((e) => e.path === `.git/${name}`);

      if (index >= 0) entries.splice(index, 1);
      await add(context, gitRoot, name, `.git/${name}`, true);
    }
  }

  const fileEntries = entries.filter((e) => !e.directory);
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const ahead = await git(root, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const status = await freshGit(() => git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));

  if (!status.ok) throw copyError("Could not read repository changes. Refresh and retry.");
  const changes = status.stdout.split("\0").filter(Boolean);
  let changedFiles = 0;

  for (let i = 0; i < changes.length; i++) {
    changedFiles++;

    if (/^[RC]|^.[RC]/.test(changes[i]!)) i++;
  }

  return {
    manifest: create(WorkspaceCopyManifestSchema, {
      token: Bun.randomUUIDv7(),
      entries,
      bytes: fileEntries.reduce((sum, e) => sum + e.size, 0n),
      files: fileEntries.length,
      skippedDirectories,
      branch: branch.ok ? branch.stdout.trim() : "",
      unpushedCommits: ahead.ok ? Number(ahead.stdout.trim()) : undefined,
      changedFiles,
    }),
    files,
  };
}

interface ScanContext {
  root: string;
  included: Set<string>;
  requiredDirectories: Set<string>;
  ignoredDirectories: Set<string>;
  entries: WorkspaceCopyEntry[];
  files: Map<string, ScannedFile>;
  manifestBytes: number;
  skippedDirectories: string[];
}

async function walk(
  ctx: ScanContext,
  root: string,
  path: string,
  prefix: string,
  metadata: boolean,
  linked = false,
): Promise<void> {
  const names = await readdir(join(root, path));

  for (const name of names.sort()) {
    if (
      (!metadata && !path && name === ".git") ||
      (metadata && !path && ["worktrees", "commondir", "gitdir"].includes(name))
    )
      continue;

    if (
      metadata &&
      linked &&
      !path &&
      ["HEAD", "index", "config.worktree", "ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "CHERRY_PICK_HEAD"].includes(name)
    )
      continue;
    const local = path ? `${path}/${name}` : name;

    if (!metadata && path && name === ".git")
      throw copyError("Repositories with nested Git checkouts must be cloned instead of copied.");
    const display = prefix ? `${prefix}/${local}` : local;
    const entry = await add(ctx, root, local, display, metadata);

    if (entry?.directory && !entry.blocked) await walk(ctx, root, local, prefix, metadata, linked);
  }
}

async function add(ctx: ScanContext, root: string, path: string, display: string, metadata: boolean) {
  const full = join(root, path);
  await checkedParent(root, full);
  const info = await lstat(full);
  const symlink = info.isSymbolicLink() ? await readlink(full) : "";

  const ignored =
    !metadata &&
    (info.isDirectory()
      ? display.split("/").some((_, i, parts) => ctx.ignoredDirectories.has(parts.slice(0, i + 1).join("/")))
      : !ctx.included.has(display));

  if (
    ignored &&
    copyGenerated(info.isDirectory() || symlink ? display : dirname(display)) &&
    (!info.isDirectory() || !ctx.requiredDirectories.has(display))
  ) {
    const parts = display.split("/");

    const skipped = parts
      .slice(0, parts.findIndex((_, i) => copyGenerated(parts.slice(0, i + 1).join("/"))) + 1)
      .join("/");

    if (!ctx.skippedDirectories.includes(skipped)) {
      ctx.skippedDirectories.push(skipped);
      ctx.manifestBytes += Buffer.byteLength(skipped) + 8;
    }

    if (ctx.entries.length + ctx.skippedDirectories.length >= COPY_MAX_ENTRIES)
      throw copyError("This repository has more than 100,000 entries. Reduce it before copying.");

    if (ctx.manifestBytes > COPY_MANIFEST_BYTES)
      throw copyError("The file list exceeds 8 MB. Reduce the repository before copying.");

    return;
  }

  if (ctx.entries.length + ctx.skippedDirectories.length >= COPY_MAX_ENTRIES)
    throw copyError("This repository has more than 100,000 entries. Reduce it before copying.");
  ctx.manifestBytes += Buffer.byteLength(display) + 160;

  if (ctx.manifestBytes > COPY_MANIFEST_BYTES)
    throw copyError("The file list exceeds 8 MB. Reduce the repository before copying.");

  let blocked = !copySafePath(display) ? "Unsupported path" : "";

  if (
    symlink &&
    (isAbsolute(symlink) || symlink.includes("\\") || !within(ctx.root, resolve(full, "..", symlink)) || metadata)
  )
    blocked = "Symlink points outside the repository";

  if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) blocked = "Unsupported file type";

  if (display === ".git/objects/info/alternates") blocked = "Repository uses external Git objects";

  if (display.endsWith(".lock") && metadata) blocked = "Git operation in progress";

  const entry = create(WorkspaceCopyEntrySchema, {
    path: display,
    size: info.isDirectory() ? 0n : BigInt(info.isSymbolicLink() ? Buffer.byteLength(symlink) : info.size),
    mode: info.mode & 0o777,
    symlink,
    directory: info.isDirectory(),
    ignored,
    metadata,
    included:
      !blocked &&
      (metadata || !ignored || ((copyLocalConfig(display) || copySecret(display)) && info.size <= 1024 ** 2)),
    secret: copySecret(display),
    blocked,
  });

  ctx.entries.push(entry);

  if (info.isFile() || info.isSymbolicLink())
    ctx.files.set(display, { root, path, size: info.size, mtime: info.mtimeMs, ino: info.ino, dev: info.dev });

  return entry;
}
