import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Source keys of the CLI import (docs/import.md, "Bezpieczeństwo"): the gateway never sends a path. A key names a
 * root the worker found itself and a path inside it, signed with a key that never leaves this worker. Every read
 * resolves the key again: the root must still be one of this worker's roots, the path must stay inside the root
 * after realpath, and the entry must be the expected kind without a symlink on the way.
 */

export type AgentCli = "claude" | "codex" | "grok";

export interface ImportRootPath {
  readonly id: string;
  readonly agentCli: AgentCli;
  /** Real path (realpath) of the CLI's home. */
  readonly path: string;
}

export class SourceKeyError extends Error {}

/** Per-worker HMAC key in `<data_dir>/import/key` (0600); created on first use. */
export function importKey(dataDir: string): Buffer {
  const dir = join(dataDir, "import");
  const path = join(dir, "key");
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });

  return readFileSync(path);
}

export function rootId(key: Buffer, agentCli: AgentCli, realPath: string): string {
  return createHmac("sha256", key).update(`root\0${agentCli}\0${realPath}`).digest("hex").slice(0, 24);
}

function signature(key: Buffer, root: string, rel: string): Buffer {
  return createHmac("sha256", key).update(`source\0${root}\0${rel}`).digest().subarray(0, 16);
}

export function signSourceKey(key: Buffer, root: ImportRootPath, path: string): string {
  const rel = relative(root.path, path).split(sep).join("/");

  return `${root.id}.${Buffer.from(rel).toString("base64url")}.${signature(key, root.id, rel).toString("base64url")}`;
}

export interface ResolvedSource {
  readonly root: ImportRootPath;
  readonly path: string;
}

/** Resolves a key to a path inside one of `roots`; throws SourceKeyError for anything else. */
export function resolveSourceKey(
  key: Buffer,
  roots: readonly ImportRootPath[],
  sourceKey: string,
  kind: "file" | "directory",
): ResolvedSource {
  const [id = "", encoded = "", mac = ""] = sourceKey.split(".");
  const rel = Buffer.from(encoded, "base64url").toString();
  const given = Buffer.from(mac, "base64url");
  const expected = signature(key, id, rel);

  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new SourceKeyError("the source key is not valid on this worker");
  const root = roots.find((r) => r.id === id);

  if (!root) throw new SourceKeyError("the source is no longer on this worker");

  return { root, path: confinedPath(root, rel, kind) };
}

/** `rel` inside the root, as a real path: no `..`, no symbolic link on the way, and the expected kind. */
export function confinedPath(root: ImportRootPath, rel: string, kind: "file" | "directory"): string {
  const parts = rel.split("/");

  if (!rel || isAbsolute(rel) || parts.some((p) => p === ".." || p === "" || p === "."))
    throw new SourceKeyError("the source path is not inside its directory");
  let current = root.path;

  // No symlink on the way: each component is checked, then the real path must stay inside the root.
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatOrUndefined(current);

    if (!stat) throw new SourceKeyError("the source no longer exists");

    if (stat.isSymbolicLink()) throw new SourceKeyError("the source path contains a symbolic link");
  }

  const real = realpathSync(current);

  if (!real.startsWith(root.path + sep)) throw new SourceKeyError("the source path is not inside its directory");
  const stat = lstatSync(real);

  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new SourceKeyError(`the source is not a ${kind}`);

  return real;
}

/** The path a valid key names, relative to its root (for keys that may only name fixed places). */
export function sourceKeyPath(sourceKey: string): string {
  return Buffer.from(sourceKey.split(".")[1] ?? "", "base64url").toString();
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
