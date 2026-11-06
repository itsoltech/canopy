import { basename, dirname, join } from "node:path";
import type { AdoptImportedSession, RemoveImportedCopy } from "@canopy/contracts";
import { CommandError } from "../runtime/host-types.ts";
import { CopyError, PrivateCopy, removeCopy } from "./copy.ts";
import type { Masker } from "./masking.ts";
import { ConfinementError, directoryEntries, lines, prefixSha, type SourceFile } from "./read.ts";
import { maskedFile, maskedLines, UnsafeCopy } from "./sanitize.ts";
import type { WorkerImport } from "./service.ts";
import { resolveSourceKey, SourceKeyError } from "./source-key.ts";

/**
 * Native continue (docs/import.md, "Kontynuacja"): the scanned prefix of a CLI session is copied, masked like the
 * imported timeline, into the private home the instance's threads run with, so the harness resumes it like one of
 * its own. The user's files are only read. A copy made from the same snapshot is left as it is.
 */

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImportHomesForProfiles {
  /** The private homes of an instance's harnesses ("" = native). */
  claudeHome(profileId: string): string;
  codexHome(profileId: string): string;
}

export function adoptImportedSession(
  service: WorkerImport,
  homes: ImportHomesForProfiles,
  command: AdoptImportedSession,
): string {
  const cli = service.agentCliOf(command.sourceKey);

  if (cli !== "claude" && cli !== "codex")
    throw new CommandError("IMPORT_UNSUPPORTED", `continuing ${cli} threads needs a newer worker`, false);

  try {
    return cli === "codex" ? adoptCodex(service, homes, command) : adoptClaude(service, homes, command);
  } catch (error) {
    if (error instanceof SourceKeyError || error instanceof ConfinementError)
      throw new CommandError("IMPORT_SOURCE", error.message, false);

    if (error instanceof UnsafeCopy || error instanceof CopyError)
      throw new CommandError("IMPORT_COPY", error.message, false);
    throw error;
  }
}

function adoptClaude(service: WorkerImport, homes: ImportHomesForProfiles, command: AdoptImportedSession): string {
  const { roots } = service.roots();
  const resolved = resolveSourceKey(service.key, roots, command.sourceKey, "file");
  const source: SourceFile = { root: resolved.root.path, path: resolved.path };
  const snapshot = checkedSnapshot(source, command);
  const sessionId = basename(source.path, ".jsonl");

  if (!SESSION.test(sessionId)) throw new CommandError("IMPORT_SOURCE", "the session id is not valid", false);

  const copy = new PrivateCopy(
    homes.claudeHome(command.profileId),
    service.copyManifest("claude", command.profileId, sessionId),
  );

  try {
    if (copy.sameAs(snapshot)) return sessionId;
    const masker = service.masker(roots);
    // The CLI named the project directory after the cwd; the copy keeps that name (the thread keeps the cwd).
    const project = join("projects", basename(dirname(source.path)));
    const end = completeLines(source, Number(snapshot.size));
    copy.write(join(project, `${sessionId}.jsonl`), maskedLines(source, end, masker));
    // Subagent transcripts and stored tool results the session points to.
    copyTree(
      copy,
      { root: source.root, path: join(dirname(source.path), sessionId) },
      join(project, sessionId),
      masker,
    );
    copy.commit(snapshot);

    return sessionId;
  } finally {
    copy.abort();
  }
}

/** Codex finds a thread's rollout under sessions/YYYY/MM/DD by its file name (archived ones too). */
function adoptCodex(service: WorkerImport, homes: ImportHomesForProfiles, command: AdoptImportedSession): string {
  const { roots } = service.roots();
  const resolved = resolveSourceKey(service.key, roots, command.sourceKey, "file");
  const source: SourceFile = { root: resolved.root.path, path: resolved.path };
  const snapshot = checkedSnapshot(source, command);
  const file = basename(source.path);
  // rollout-<time>-<thread id>.jsonl
  const sessionId = basename(file, ".jsonl").slice(-36);
  const date = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(file);

  if (!SESSION.test(sessionId) || !date)
    throw new CommandError("IMPORT_SOURCE", "the rollout name is not valid", false);

  const copy = new PrivateCopy(
    homes.codexHome(command.profileId),
    service.copyManifest("codex", command.profileId, sessionId),
  );

  try {
    if (copy.sameAs(snapshot)) return sessionId;
    const end = completeLines(source, Number(snapshot.size));
    copy.write(join("sessions", date[1]!, date[2]!, date[3]!, file), maskedLines(source, end, service.masker(roots)));
    copy.commit(snapshot);

    return sessionId;
  } finally {
    copy.abort();
  }
}

/** The private home each CLI's copies live in. */
const HOMES = new Map<string, (homes: ImportHomesForProfiles, profileId: string) => string>([
  ["claude", (homes, profileId) => homes.claudeHome(profileId)],
  ["codex", (homes, profileId) => homes.codexHome(profileId)],
]);

/** The source still starts as it did at the scan; the snapshot as the manifest records it. */
export function checkedSnapshot(source: SourceFile, command: AdoptImportedSession) {
  const size = Number(command.snapshot?.size ?? 0n);

  if (!command.snapshot || prefixSha(source, size) !== command.snapshot.prefixSha256)
    throw new CommandError("IMPORT_SOURCE_CHANGED", "the source changed since the scan; scan again", false);

  return { size: String(size), prefixSha256: command.snapshot.prefixSha256 };
}

/** Deletes the files an import's copy of this session wrote (its manifest), nothing else. */
export function removeImportedCopy(
  service: WorkerImport,
  homes: ImportHomesForProfiles,
  command: RemoveImportedCopy,
): void {
  if (!SESSION.test(command.sessionId)) return;
  // The home the worker expects now, never one a manifest names.
  const home = HOMES.get(command.agentCli)?.(homes, command.profileId);

  if (home) removeCopy(service.copyManifest(command.agentCli, command.profileId, command.sessionId), home);
}

/** Length of the prefix that ends at a complete line (a line the CLI was still writing is left out). */
export function completeLines(file: SourceFile, size: number): number {
  let end = 0;

  for (const line of lines(file, 0, size)) end = line.end;

  return end;
}

/** Regular files and directories of a confined tree, masked; links are not followed or copied. */
export function copyTree(copy: PrivateCopy, from: SourceFile, to: string, masker: Masker): void {
  for (const entry of directoryEntries(from)) {
    const child: SourceFile = { root: from.root, path: join(from.path, entry.name) };
    const target = join(to, entry.name);

    if (entry.isDirectory()) copyTree(copy, child, target, masker);
    else if (entry.isFile()) {
      const content = maskedFile(child, masker);

      if (content) copy.write(target, content);
    }
  }
}
