import type { WorkspaceCopyEntry } from "@canopy/contracts";

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
    path.includes("vendor/bundle/") ||
    path.includes(".yarn/cache/")
  );
}

export const copyLocalConfig = (path: string) =>
  /(?:^|\/)(?:\.env[^/]*|[^/]+\.local|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|NuGet\.Config)$/i.test(path);

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

export const copySize = (bytes: bigint | number) => {
  const n = Number(bytes);

  if (n < 1024) return `${n} B`;

  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;

  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;

  return `${(n / 1024 ** 3).toFixed(1)} GB`;
};
