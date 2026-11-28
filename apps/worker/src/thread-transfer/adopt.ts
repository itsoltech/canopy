import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { copiedFiles, PrivateCopy, walk } from "../import/copy.ts";
import { transferError } from "./errors.ts";
import { checkSessionLayout, sessionRoot, type ExportedSession } from "./sessions.ts";

/**
 * Adopting moved sessions on the target (docs/thread-transfers.md). Each session's files are published into the
 * home its instance resumes from with the import's private copy (identity checked, never through a link). A file of
 * the same session already there (the thread lived on this worker before) is first moved aside, so a cancelled move
 * puts it back. The plan is saved before the first change and every undo step is safe to repeat.
 */

export interface AdoptionHome {
  home: string;
  /** The copy manifest the harness reads (Codex normalizes the provider of a manifest-owned rollout). */
  manifest: string;
  /**
   * Canopy already runs this session in this home (its journal binding, or a home only Canopy writes): a file of the
   * session there is Canopy's. Otherwise only files of the manifest's own copy may be replaced.
   */
  owned: boolean;
  /** A shared CLI home the journal must bind this session to for resume; bound by the adoption, undone on cancel. */
  binding?: string;
}

export const adoptionRecord = z.object({
  home: z.string(),
  manifest: z.string(),
  /** This session's files moved aside, next to the home's files (a rename never crosses file systems). */
  backups: z.string(),
  /** Where a manifest that was there before is moved aside; "" when there was none. */
  manifestBackup: z.string().default(""),
  /** Published files and the SHA-256 of their content: an undo removes only what is still this content. */
  files: z.array(z.object({ rel: z.string(), sha256: z.string() })),
  /** rel → backup path of a file this adoption replaces. */
  displaced: z.record(z.string(), z.string()),
  /** The manifest this adoption wrote ("" until it is saved after publishing): an undo touches only that one. */
  manifestSha256: z.string().default(""),
  /** The adopted provider session and the thread it belongs to. */
  session: z.string().default(""),
  thread: z.string().default(""),
  /** This adoption recorded in the journal that the Codex session has history (a cancel removes that). */
  history: z.boolean().default(false),
  /** A journal binding of the session to a shared CLI home this adoption created (a cancel removes it). */
  binding: z.string().default(""),
  /** rel → identity (dev:ino) of each file this adoption published, saved right after: an undo removes only those. */
  published: z.record(z.string(), z.string()).default({}),
});

export type AdoptionRecord = z.infer<typeof adoptionRecord>;

const CHUNK = 1024 ** 2;

const identityOf = (path: string) => {
  const info = lstatSync(path, { bigint: true });

  return `${info.dev}:${info.ino}`;
};

/** Session paths travel `/`-separated (checked portable); the home uses this system's separator. */
const native = (rel: string) => rel.split("/").join(sep);
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false });

/** A file read in pieces, for hashing and for the private copy (never whole in memory). */
function* chunks(path: string): Generator<Uint8Array> {
  const fd = openSync(path, "r");

  try {
    const buffer = Buffer.alloc(CHUNK);

    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) yield buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function sha256(path: string) {
  const hash = createHash("sha256");

  for (const chunk of chunks(path)) hash.update(chunk);

  return hash.digest("hex");
}

/**
 * What adopting one session will change; nothing is touched yet. `existing` lists every file of the session already
 * in the home (`sessionFilesIn`): each is moved aside, so the home keeps one history per session; one Canopy doesn't
 * own refuses the move.
 */
export function planAdoption(
  stage: string,
  token: string,
  session: ExportedSession,
  target: AdoptionHome,
  existing: readonly string[],
) {
  checkSessionLayout(session);
  const root = join(stage, sessionRoot(session.threadId));
  const backups = join(target.home, `.canopy-transfer-${token}-${session.providerThreadId}`);

  const record: AdoptionRecord = {
    home: target.home,
    manifest: target.manifest,
    backups,
    manifestBackup: exists(target.manifest) ? `${target.manifest}.transfer-${token}-${session.providerThreadId}` : "",
    manifestSha256: "",
    session: session.providerThreadId,
    thread: session.threadId,
    history: false,
    binding: target.binding && !target.owned ? target.binding : "",
    published: {},
    files: session.files.map((rel) => ({ rel, sha256: sha256(join(root, native(rel))) })),
    displaced: {},
  };

  const copied = new Set(copiedFiles(target.manifest, target.home)?.files ?? []);

  for (const [i, rel] of [...new Set([...session.files, ...existing])].entries()) {
    if (!exists(join(target.home, native(rel)))) continue;

    // A session file Canopy does not own here (for example the CLI's own, in a shared home) is never replaced.
    if (!target.owned && !copied.has(native(rel)))
      throw transferError("This worker already has this session outside Canopy. Move it away there first.");

    // Only this session's own file, through real directories, is moved aside (the layout was checked above).
    if (!walk(target.home, native(rel), "file"))
      throw transferError("The target's session home holds something else where the session belongs.");
    record.displaced[rel] = join(backups, String(i));
  }

  return record;
}

/** Carries out a saved plan; on failure it is undone (and may be undone again later). */
export function performAdoption(stage: string, session: ExportedSession, record: AdoptionRecord) {
  const root = join(stage, sessionRoot(session.threadId));

  try {
    mkdirSync(record.backups, { recursive: true, mode: 0o700 });

    if (record.manifestBackup && exists(record.manifest)) renameSync(record.manifest, record.manifestBackup);

    for (const [rel, backup] of Object.entries(record.displaced)) {
      if (!walk(record.home, native(rel), "file"))
        throw transferError("The target's session home changed while the session was moved.");
      renameSync(join(record.home, native(rel)), backup);
    }

    const copy = new PrivateCopy(record.home, record.manifest);

    try {
      for (const file of record.files) copy.write(native(file.rel), chunks(join(root, native(file.rel))));
      copy.commit({ size: String(record.files.length), prefixSha256: `transfer:${session.providerThreadId}` });
    } finally {
      copy.abort();
    }

    record.manifestSha256 = sha256(record.manifest);

    for (const file of record.files) record.published[file.rel] = identityOf(join(record.home, native(file.rel)));
  } catch (error) {
    undoAdoption(record);
    throw error;
  }
}

/** Real directories from the home down to `rel`'s folder, made when missing; a link or file on the way refuses. */
function realParents(home: string, rel: string) {
  let current = home;

  for (const part of rel.split("/").slice(0, -1)) {
    current = join(current, part);

    if (!exists(current)) mkdirSync(current, { mode: 0o700 });

    if (!walk(home, relative(home, current), "directory"))
      throw transferError("The target's session home changed while the session was moved.");
  }
}

/**
 * Removes what an adoption published and puts back what it replaced, including the earlier manifest. Repeatable. A
 * path holding other content than the adoption published (written since) is left as it is, with its backup kept.
 */
export function undoAdoption(record: AdoptionRecord) {
  let kept = false;
  const published = new Map(record.files.map((f) => [f.rel, f.sha256]));

  for (const rel of new Set([...published.keys(), ...Object.keys(record.displaced)])) {
    const path = join(record.home, native(rel));
    const backup = record.displaced[rel];
    const restore = backup !== undefined && exists(backup) !== undefined;
    const sha = published.get(rel);
    const identity = record.published[rel];
    const inPlace = sha !== undefined && walk(record.home, native(rel), "file") !== undefined;

    // This adoption's file, unchanged: its identity (a later move's copy of the same bytes is another file; unknown
    // only after a crash before it was saved) and its content (a CLI may have appended to it in place since).
    const ours = inPlace && (!identity || identityOf(path) === identity) && sha256(path) === sha;

    // Without its backup a displaced path holds the original (never moved, or already restored).
    if ((backup === undefined || restore) && ours) unlinkSync(path);

    if (!restore) continue;

    if (exists(path)) {
      kept = true;
      continue;
    }

    realParents(record.home, rel);
    renameSync(backup, path);
  }

  // The manifest is this adoption's only while it is the one it wrote (a later move may own it now).
  if (manifestOurs(record)) {
    if (!record.manifestBackup) rmSync(record.manifest, { force: true });
    else if (exists(record.manifestBackup)) {
      rmSync(record.manifest, { force: true });
      renameSync(record.manifestBackup, record.manifest);
    }
  }

  if (!kept) rmSync(record.backups, { recursive: true, force: true });
}

/** Absent, or the content this adoption wrote (before that was saved: a manifest of this transfer's session copy). */
function manifestOurs(record: AdoptionRecord) {
  const info = exists(record.manifest);

  if (!info) return true;

  if (!info.isFile() || info.isSymbolicLink()) return false;

  if (record.manifestSha256) return sha256(record.manifest) === record.manifestSha256;

  return Boolean(record.session) && readFileSync(record.manifest, "utf8").includes(`"transfer:${record.session}"`);
}

/** After the move: what was replaced is no longer needed. */
export function settleAdoption(record: AdoptionRecord) {
  rmSync(record.backups, { recursive: true, force: true });

  if (record.manifestBackup) rmSync(record.manifestBackup, { force: true });
}
