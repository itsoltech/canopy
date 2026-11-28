import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import type { ThreadTransferSession } from "@canopy/contracts";
import { openSource } from "../import/read.ts";
import { nativeRollout } from "../providers/codex/recovery-rollout.ts";
import { transcriptPath } from "../providers/claude/transcript.ts";
import { copySafePath } from "@canopy/domain/workspace-copy";
import { transferError } from "./errors.ts";

/**
 * Harness sessions of a moved thread (docs/thread-transfers.md). The source copies each session's files, relative to
 * its harness home, into the package (`sessions/<thread id>/<home-relative path>`); the target adopts them in the home
 * its instance resumes from. Claude keeps the project directory named after the old folder: its resume finds a
 * session by id in any project directory and keeps writing there, as after a worktree switch.
 */

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where the source finds a session: resolved by the worker, never taken from the gateway. */
export interface SessionLocator {
  claudeHomes(session: ThreadTransferSession): Promise<string[]>;
  codexHomes(session: ThreadTransferSession): Promise<string[]>;
  /** The journal marks this session's history as holding a project secret: it never leaves the worker. */
  secretHistory(session: ThreadTransferSession): Promise<boolean>;
}

export interface ExportedSession {
  threadId: string;
  provider: string;
  providerThreadId: string;
  /** Paths relative to the harness home, under `sessions/<thread id>/` in the package. */
  files: string[];
}

export const sessionRoot = (threadId: string) => join("sessions", threadId);

/** Copies each session into `pkg`; threads without a session on this worker are returned as missing. */
export async function exportSessions(
  sessions: readonly ThreadTransferSession[],
  pkg: string,
  locate: SessionLocator,
  write = true,
): Promise<{ exported: ExportedSession[]; missing: string[] }> {
  const exported: ExportedSession[] = [];
  const missing: string[] = [];

  for (const session of sessions) {
    if (!SESSION.test(session.threadId) || !SESSION.test(session.providerThreadId)) {
      missing.push(session.threadId);
      continue;
    }

    if (await locate.secretHistory(session))
      throw transferError("This thread's history holds a project secret, so its session can't move to another worker.");
    const found = await sessionFiles(session, locate);

    if (!found) {
      missing.push(session.threadId);
      continue;
    }

    const root = join(pkg, sessionRoot(session.threadId));
    const files: string[] = [];

    for (const file of found.files) {
      // Only a compressed Codex rollout is unpacked (Codex resumes the plain one); every other file moves as it is.
      const unpack = session.provider === "codex" && file.rel.endsWith(".zst");
      const rel = unpack ? file.rel.slice(0, -4) : file.rel;
      files.push(rel.split(sep).join("/"));

      // Inspect only asks whether the session is there.
      if (!write) continue;
      const destination = join(root, rel);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

      // Read through a descriptor confined to the harness home: no link on the way, never reopened by name.
      const source = createReadStream("", { fd: openSource({ root: found.home, path: file.from }) });
      const target = createWriteStream(destination, { mode: 0o600, flags: "wx" });

      if (unpack) await pipeline(source, createZstdDecompress(), target);
      else await pipeline(source, target);
    }

    exported.push({
      threadId: session.threadId,
      provider: session.provider,
      providerThreadId: session.providerThreadId,
      files,
    });
  }

  return { exported, missing };
}

async function sessionFiles(session: ThreadTransferSession, locate: SessionLocator) {
  if (session.provider === "claude") return claudeFiles(session, await locate.claudeHomes(session));

  if (session.provider === "codex") return codexFiles(session, await locate.codexHomes(session));

  return undefined;
}

interface FoundSession {
  /** The harness home every file is confined to. */
  home: string;
  /** `from`: the file on this worker; `rel`: its place relative to the harness home on the target. */
  files: { from: string; rel: string }[];
}

/** The transcript and the session's directory (subagents, stored tool results) next to it. */
async function claudeFiles(
  session: ThreadTransferSession,
  homes: readonly string[],
): Promise<FoundSession | undefined> {
  for (const home of homes) {
    const transcript = transcriptPath(home, session.providerThreadId);

    if (!transcript || !(await lstat(transcript)).isFile()) continue;
    const files = [{ from: transcript, rel: relative(home, transcript) }];
    const directory = join(dirname(transcript), session.providerThreadId);

    for (const path of await regularFiles(directory)) files.push({ from: path, rel: relative(home, path) });

    return { home, files };
  }

  return undefined;
}

/** The rollout named after the thread (Codex's own name parser), in `sessions` or `archived_sessions`, maybe compressed. */
async function codexFiles(session: ThreadTransferSession, homes: readonly string[]): Promise<FoundSession | undefined> {
  for (const home of homes) {
    for (const top of ["sessions", "archived_sessions"]) {
      for (const path of await regularFiles(join(home, top))) {
        const active = nativeRollout(path, session.providerThreadId)?.locations.find((l) => l.startsWith("sessions"));

        // Codex finds a resumed thread under sessions/YYYY/MM/DD by its name; an archived one moves back there.
        if (active) return { home, files: [{ from: path, rel: join(active, basename(path)) }] };
      }
    }
  }

  return undefined;
}

/** Regular files below `directory` through real directories only; a missing directory has none (other errors throw). */
export async function regularFiles(directory: string): Promise<string[]> {
  const found: string[] = [];

  const info = await lstat(directory).catch((error: Error) => {
    if ("code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });

  if (!info?.isDirectory()) return found;

  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);

    if (item.isDirectory()) found.push(...(await regularFiles(path)));
    else if (item.isFile()) found.push(path);
  }

  return found;
}

/** Portable on every system: `/`-separated plain names, no backslash, drive, link names or reserved names. */
function checkSessionFile(rel: string) {
  if (!copySafePath(rel)) throw transferError("A session file has a path that cannot be moved.");
}

/**
 * The receiver's check of a moved session: ids are session UUIDs and every file sits exactly where that provider
 * keeps this session (Claude: one project directory with the transcript and its folder; Codex: one rollout under
 * sessions/YYYY/MM/DD). A package can't name any other file of the harness home.
 */
export function checkSessionLayout(session: ExportedSession) {
  const id = session.providerThreadId;

  // Lower-case ids only: the same session can't arrive under another spelling (Codex matches rollouts by id).
  if (!LOWER_SESSION.test(session.threadId) || !LOWER_SESSION.test(id) || !session.files.length)
    throw transferError("The moved session is not valid.");
  session.files.forEach(checkSessionFile);

  if (session.provider === "claude") {
    const parts = session.files.map((rel) => rel.split("/"));
    const project = parts[0]![1];

    const fits = parts.every(
      (p) =>
        p[0] === "projects" &&
        p[1] === project &&
        ((p.length === 3 && p[2] === `${id}.jsonl`) || (p.length > 3 && p[2] === id)),
    );

    if (fits && session.files.includes(`projects/${project}/${id}.jsonl`)) return;
  }

  if (session.provider === "codex" && session.files.length === 1) {
    const rel = session.files[0]!;
    // Codex's own parser, on the path as it would be in a home: an active, uncompressed rollout of this session.
    const rollout = rel.endsWith(".jsonl") ? nativeRollout(join(resolve("/home"), ...rel.split("/")), id) : undefined;
    const active = rollout?.locations.find((l) => l.startsWith("sessions"));

    if (rollout && active && rel === [...active.split(sep), rollout.name].join("/")) return;
  }

  throw transferError("The moved session is not where its harness keeps it.");
}

/**
 * Every file of session `id` already in the harness home, wherever that harness may keep it (Claude: any project
 * directory; Codex: any date, archived or compressed), relative to the home with `/`.
 */
export async function sessionFilesIn(home: string, provider: string, id: string): Promise<string[]> {
  const rel = (path: string) => relative(home, path).split(sep).join("/");
  const found: string[] = [];

  if (provider === "codex")
    for (const top of ["sessions", "archived_sessions"])
      for (const path of await regularFiles(join(home, top))) if (nativeRollout(path, id)) found.push(rel(path));

  if (provider === "claude") {
    const projects = join(home, "projects");

    const entries = await readdir(projects, { withFileTypes: true }).catch((error: Error) => {
      if ("code" in error && error.code === "ENOENT") return [];
      throw error;
    });

    // Real project directories only (a stray file such as .DS_Store is not one).
    for (const name of entries.filter((e) => e.isDirectory()).map((e) => e.name)) {
      const transcript = join(projects, name, `${id}.jsonl`);

      const info = await lstat(transcript).catch((error: Error) => {
        if ("code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });

      if (info?.isFile()) found.push(rel(transcript));

      for (const path of await regularFiles(join(projects, name, id))) found.push(rel(path));
    }
  }

  return found;
}
