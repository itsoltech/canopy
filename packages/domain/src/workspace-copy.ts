import type { WorkspaceCopyEntry, WorkspaceCopyManifest } from "@canopy/contracts";

export { copyTree, visibleCopyTree, toggleCopyNode, type CopyTreeNode } from "./workspace-copy-tree.ts";

export const COPY_CHUNK_BYTES = 128 * 1024;
export const COPY_MAX_BYTES = 20 * 1024 ** 3;
export const COPY_MAX_FILE_BYTES = 8 * 1024 ** 3;
export const COPY_MAX_ENTRIES = 100_000;
export const COPY_MANIFEST_BYTES = 8 * 1024 ** 2;
export const COPY_IDLE_MS = 10 * 60_000;

/** One curated list, shared by scanning, selection and both clients. Tracked files always win. */
export const COPY_GENERATED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "target",
  "bin",
  "obj",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".gradle",
  ".dart_tool",
  "Pods",
  "DerivedData",
  "coverage",
  ".cache",
  ".svelte-kit",
  ".expo",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".angular",
  "bower_components",
  "Carthage",
  ".terraform",
  ".yarn/cache",
  "vendor/bundle",
]);

export function copyGenerated(path: string): boolean {
  const parts = path.split("/");

  return (
    parts.some((part) => COPY_GENERATED_DIRECTORIES.has(part)) ||
    /(?:^|\/)(?:vendor\/bundle|\.yarn\/cache)(?:\/|$)/.test(path)
  );
}

export const copyLocalConfig = (path: string) =>
  /(?:^|\/)(?:\.env[^/]*|[^/]+\.local|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|NuGet\.Config)$/i.test(path) ||
  /(?:^|\/)(?:\.vscode|\.idea)(?:\/|$)/i.test(path);

export const copySecret = (path: string) =>
  copyLocalConfig(path) ||
  /(?:^|\/)(?:\.ssh|\.aws|\.kube|\.docker|keys)(?:\/|$)/i.test(path) ||
  /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials[^/]*|secrets?[^/]*|\.git\/config)(?:$|\/)/i.test(
    path,
  ) ||
  /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(path) ||
  path.startsWith(".git/config");

/** Portable relative paths only; no drive, ADS, traversal, control chars or Windows normalization aliases. */
export function copySafePath(path: string): boolean {
  return (
    Boolean(path) &&
    path.length <= 4096 &&
    !/[\\:]/.test(path) &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    path
      .split("/")
      .every(
        (p) =>
          Boolean(p) &&
          p !== "." &&
          p !== ".." &&
          !/[. ]$/.test(p) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  );
}

export function copyTotals(entries: readonly WorkspaceCopyEntry[]) {
  const files = entries.filter((e) => !e.directory);

  return { files: files.length, bytes: files.reduce((sum, e) => sum + e.size, 0n) };
}

export const copyFileCount = (count: number) => `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`;

export const copySelectable = (entry: WorkspaceCopyEntry) => entry.ignored && !entry.metadata;

export function copySelection(entries: readonly WorkspaceCopyEntry[], ignored: ReadonlySet<string>) {
  return entries.filter((e) => !copySelectable(e) || ignored.has(e.path));
}

export function copyUnavailableReason(entries: readonly WorkspaceCopyEntry[]) {
  if (entries.some((e) => e.blocked))
    return "Some repository files cannot be copied. Resolve unsafe paths or active Git operations, then refresh.";

  if (copyTotals(entries).bytes > COPY_MAX_BYTES || entries.some((e) => e.size > COPY_MAX_FILE_BYTES))
    return "Choose up to 20 GB in total and 8 GB per file.";

  return entries.some((e) => !e.directory) ? "" : "No files to copy. Refresh the file list.";
}

export function copyRepositorySummary(manifest: WorkspaceCopyManifest) {
  const totals = copyTotals(manifest.entries.filter((e) => !copySelectable(e)));
  const commits = manifest.unpushedCommits;

  return {
    overview: `Repository · ${copyFileCount(totals.files)} · ${copySize(totals.bytes)}`,
    branch: manifest.branch || "Detached HEAD",
    changes: [
      ...(commits === undefined
        ? []
        : [`${commits.toLocaleString()} unpushed ${commits === 1 ? "commit" : "commits"}`]),
      `${manifest.changedFiles.toLocaleString()} changed ${manifest.changedFiles === 1 ? "file" : "files"}`,
    ].join(" · "),
  };
}

export function copySkippedSummary(directories: readonly string[]) {
  const preferred = ["node_modules", "target"].filter((path) => directories.includes(path));
  const first = [...preferred, ...directories.filter((path) => !preferred.includes(path))].slice(0, 2).join(", ");
  const extra = directories.length - 2;

  return `Skipped: ${first}${extra > 0 ? ` and ${extra.toLocaleString()} more` : ""} (dependencies and build output)`;
}

export const copySize = (bytes: bigint | number) => {
  const n = Number(bytes);

  if (n < 1024) return `${n} B`;

  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;

  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;

  return `${(n / 1024 ** 3).toFixed(1)} GB`;
};
