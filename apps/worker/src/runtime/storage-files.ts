import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { Provider } from "@canopy/contracts";
import { antigravitySessionRoot } from "../providers/antigravity/home.ts";
import { Schema } from "effect";
import type { StorageCleanupGrant } from "../journal/index.ts";

const ID = /^[a-z0-9][a-z0-9_-]{0,159}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CodexMeta = Schema.Struct({
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({ id: Schema.String }),
});

/** Every path is derived locally. Configured external homes and links remain outside the managed cleanup scope. */
export function removeThreadStorage(
  dataDir: string,
  grant: StorageCleanupGrant,
  home: string,
  protectedSessionIds: ReadonlySet<string> = new Set(),
): void {
  if (!UUID.test(grant.threadId)) throw new Error("Invalid storage cleanup thread");
  const attachments = join(resolve(dataDir), "attachments", grant.threadId);
  removeConfined(dataDir, attachments);

  if (!isManagedStorageHome(dataDir, home, grant.provider)) return;

  if (grant.provider === Provider.ANTIGRAVITY) {
    // Antigravity conversations and artifacts live in a store dedicated to one Canopy thread.
    if (
      ID.test(grant.providerProfileId) &&
      resolve(home) === resolve(antigravitySessionRoot(dataDir, grant.providerProfileId))
    )
      removeConfined(dataDir, join(home, grant.threadId));

    return;
  }

  for (const id of grant.providerThreadIds) {
    if (!ID.test(id)) continue;

    if (protectedSessionIds.has(id)) continue;

    if (grant.provider === Provider.CLAUDE) {
      const projects = join(home, "projects");

      for (const group of directories(dataDir, projects)) {
        removeConfined(dataDir, join(group, `${id}.jsonl`));
        removeConfined(dataDir, join(group, id));
      }
    } else if (grant.provider === Provider.CODEX) {
      for (const kind of ["sessions", "archived_sessions"])
        for (const path of sessionFiles(dataDir, join(home, kind), 4))
          if (basename(path).endsWith(`-${id}.jsonl`) && codexSession(path) === id) removeConfined(dataDir, path);
      removeConfined(dataDir, join(home, "shell_snapshots", `${id}.sh`));
    } else if (grant.provider === Provider.GROK) {
      for (const group of directories(dataDir, home)) removeConfined(dataDir, join(group, id));
    }
  }
}

export function isManagedStorageHome(dataDir: string, home: string, provider: number): boolean {
  const parts = relative(resolve(dataDir), resolve(home)).split(sep);

  if (provider === Provider.GROK || provider === Provider.ANTIGRAVITY) {
    const harness = provider === Provider.GROK ? "grok" : "antigravity";

    return (
      parts.length === 3 &&
      parts[0] === harness &&
      ID.test(parts[1] ?? "") &&
      parts[2] === "sessions" &&
      confined(dataDir, home)
    );
  }

  if (provider !== Provider.CLAUDE && provider !== Provider.CODEX) return false;
  const harness = provider === Provider.CODEX ? "codex" : "claude";

  const owned =
    (parts.length === 1 && parts[0] === `${harness}-home`) ||
    (parts.length === 2 &&
      parts[0] === "homes" &&
      (parts[1] ?? "").startsWith(`${harness}-`) &&
      ID.test(parts[1] ?? ""));

  return owned && confined(dataDir, home);
}

/** lstat every existing path segment: a link under a managed root never expands the deletion scope. */
function confined(dataDir: string, path: string): boolean {
  const base = resolve(dataDir);
  const suffix = relative(base, resolve(path));

  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === ".." || resolve(base, suffix) !== resolve(path))
    return false;

  if (!existsSync(base)) return false;
  let current = realpathSync(base);

  for (const part of suffix.split(sep)) {
    current = join(current, part);

    if (!existsSync(current)) return true;

    if (lstatSync(current).isSymbolicLink()) return false;
  }

  return true;
}

function removeConfined(dataDir: string, path: string): void {
  if (confined(dataDir, path)) rmSync(path, { recursive: true, force: true });
}

function directories(dataDir: string, root: string): string[] {
  if (!confined(dataDir, root) || !existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

function sessionFiles(dataDir: string, root: string, depth: number): string[] {
  if (!depth || !confined(dataDir, root) || !existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);

    return entry.isDirectory()
      ? sessionFiles(dataDir, path, depth - 1)
      : entry.isFile() && entry.name.endsWith(".jsonl")
        ? [path]
        : [];
  });
}

function codexSession(path: string): string | undefined {
  const fd = openSync(path, "r");

  try {
    const prefix = Buffer.alloc(64 * 1024);
    const size = readSync(fd, prefix, 0, prefix.length, 0);
    const line = prefix.subarray(0, size).toString("utf8").split("\n")[0] ?? "";

    return Schema.decodeUnknownSync(CodexMeta)(JSON.parse(line)).payload.id;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
