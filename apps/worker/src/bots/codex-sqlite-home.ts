import { Database, constants } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import { pathToFileURL } from "node:url";
import { codexCliHomeProblem } from "../providers/home-paths.ts";

const MAX_PATH = 260;
const historyJournal = "thread_history_1.sqlite-journal";
const stateDatabase = /^(?:state|thread_history|goals|memories(?:_v2)?|queue)_[0-9]+\.sqlite$/i;
const sqliteFile = /\.sqlite(?:$|-(?:wal|shm|journal)$)/i;

function directory(path: string): boolean {
  const info = lstatSync(toNamespacedPath(path), { throwIfNoEntry: false });

  if (!info) return false;

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    relative(toNamespacedPath(path), toNamespacedPath(realpathSync(toNamespacedPath(path))))
  )
    throw new Error("The Codex bot database directory must be private and must not be a link.");

  return true;
}

function checkDatabaseFile(path: string): void {
  const info = lstatSync(toNamespacedPath(path), { throwIfNoEntry: false });

  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1))
    throw new Error("The Codex bot data contains a linked or special database file.");
}

function snapshot(source: string, destination: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) checkDatabaseFile(source + suffix);

  // The old path can already exceed MAX_PATH. Use SQLite's long-path VFS for the read-only
  // source, leaving Codex itself on its default VFS with a short writable directory.
  const uri = pathToFileURL(source).href.replace(/^file:\/\/([^/])/, "file:////$1");

  using database =
    process.platform === "win32"
      ? new Database(`${uri}?vfs=win32-longpath`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI)
      : new Database(source, { readonly: true });

  database.exec("PRAGMA busy_timeout = 2000");
  database.run("VACUUM main INTO ?", [destination]);
  const file = openSync(destination, "r+");

  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

/**
 * Windows Codex needs room for SQLite sidecars. Only SQLite moves; rollout paths in the index
 * still refer to the same private CODEX_HOME. A bot runs one turn at a time and the previous
 * app-server is joined on exit. VACUUM INTO also takes a consistent SQLite snapshot of each DB.
 */
export function prepareBotCodexSqliteHome(
  dataDir: string,
  home: string,
  identity: readonly [botId: string, conversationId: string, instance: string],
  protectedHomes: readonly string[] = [],
): string {
  const data = realpathSync(dataDir);
  const canonicalHome = realpathSync(home);
  const inside = relative(data, canonicalHome);

  if (
    !lstatSync(toNamespacedPath(home)).isDirectory() ||
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    throw new Error("The Codex bot home must be a private directory within worker data.");

  const root = join(data, "bdb");
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
  const target = join(root, key);
  const initialized = directory(root) && directory(target);

  if (
    !initialized &&
    join(resolve(home), historyJournal).length < MAX_PATH &&
    join(canonicalHome, historyJournal).length < MAX_PATH
  )
    return home;

  if (join(target, historyJournal).length >= MAX_PATH)
    throw new Error("The worker data directory is too long for the Codex bot database on Windows.");

  for (const protectedHome of [canonicalHome, ...protectedHomes]) {
    if (protectedHome && codexCliHomeProblem(target, protectedHome, protectedHome))
      throw new Error("The Codex bot database directory must be separate from provider homes.");
  }

  if (!initialized) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    directory(root);
    // Publish the directory only after taking every snapshot. If the worker stops partway,
    // the original files remain authoritative and the next turn can make a new snapshot.
    const staging = mkdtempSync(join(root, ".init-"));

    try {
      for (const name of readdirSync(toNamespacedPath(canonicalHome)))
        if (stateDatabase.test(name)) snapshot(join(canonicalHome, name), join(staging, name));

      renameSync(staging, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  if (!directory(target)) throw new Error("The Codex bot database directory is unavailable.");

  for (const name of readdirSync(target)) if (sqliteFile.test(name)) checkDatabaseFile(join(target, name));

  return target;
}
