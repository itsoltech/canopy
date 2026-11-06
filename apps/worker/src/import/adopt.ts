import { basename, dirname, join } from "node:path";
import type { AdoptImportedSession, RemoveImportedCopy } from "@canopy/contracts";
import { CommandError } from "../runtime/host-types.ts";
import { CopyError, PrivateCopy, removeCopy } from "./copy.ts";
import type { Masker } from "./masking.ts";
import { grokHistoryFile } from "./grok-history.ts";
import {
  ConfinementError,
  directoryEntries,
  lines,
  prefixSha,
  sourceExists,
  sourceStat,
  type SourceFile,
} from "./read.ts";
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
  /** Grok: the durable sessions root every process of the instance links as GROK_HOME/sessions. */
  grokSessions(profileId: string): string;
}

export function adoptImportedSession(
  service: WorkerImport,
  homes: ImportHomesForProfiles,
  command: AdoptImportedSession,
): string {
  const cli = service.agentCliOf(command.sourceKey);

  if (!cli) throw new CommandError("IMPORT_SOURCE", "the source is no longer on this worker", false);

  try {
    return ADOPT[cli](service, homes, command);
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
  ["grok", (homes, profileId) => homes.grokSessions(profileId)],
]);

/** Files of a Grok session a session/load needs (the rest, such as events, rewind points and terminal logs, stays). */
const GROK_FILES = ["summary.json", "prompt_context.json", "system_prompt.txt", "tool_definitions.json"];

/**
 * Grok keeps a session in a directory under `sessions/<encoded cwd>/<id>/`; `chat_history.jsonl` is what the model
 * gets back on session/load. The copy holds the session exactly as the scan saw it: the ACP log up to its snapshot
 * and the chat history up to its own snapshot (size and first bytes, recorded by the scan), both cut at complete
 * records. Without a snapshot of the chat history the copy is not made: the thread continues in a new one.
 */
function adoptGrok(service: WorkerImport, homes: ImportHomesForProfiles, command: AdoptImportedSession): string {
  const { roots } = service.roots();
  const resolved = resolveSourceKey(service.key, roots, command.sourceKey, "directory");
  const dir: SourceFile = { root: resolved.root.path, path: resolved.path };
  const sessionId = basename(dir.path);

  if (!SESSION.test(sessionId)) throw new CommandError("IMPORT_SOURCE", "the session id is not valid", false);
  const main = grokHistoryFile(dir);
  const chat: SourceFile = { root: dir.root, path: join(dir.path, "chat_history.jsonl") };

  if (!main || !sourceExists(chat)) throw new UnsafeCopy("this session has no chat history to continue from");
  const snapshot = checkedSnapshot(main, command);
  const chatEnd = main.path === chat.path ? Number(snapshot.size) : chatSnapshot(chat, command);

  // A copy is the same only for the same scan of both files: the ACP log's and the chat history's snapshot.
  const both = {
    size: `${snapshot.size}/${chatEnd}`,
    prefixSha256: `${snapshot.prefixSha256}/${command.snapshot?.historyPrefixSha256 ?? ""}`,
  };

  const group = join(basename(dirname(dir.path)), sessionId);

  const copy = new PrivateCopy(
    homes.grokSessions(command.profileId),
    service.copyManifest("grok", command.profileId, sessionId),
  );

  try {
    if (copy.sameAs(both)) return sessionId;
    const masker = service.masker(roots);
    copy.write(join(group, "chat_history.jsonl"), maskedLines(chat, completeLines(chat, chatEnd), masker));

    if (main.path !== chat.path)
      copy.write(
        join(group, basename(main.path)),
        maskedLines(main, completeLines(main, Number(snapshot.size)), masker),
      );

    for (const name of GROK_FILES) {
      const file: SourceFile = { root: dir.root, path: join(dir.path, name) };
      const content = sourceExists(file) ? maskedFile(file, masker) : undefined;

      if (content) copy.write(join(group, name), content);
    }

    copy.commit(both);

    return sessionId;
  } finally {
    copy.abort();
  }
}

/** The chat history as the scan saw it: its recorded size, and the same first bytes. */
function chatSnapshot(chat: SourceFile, command: AdoptImportedSession): number {
  const snapshot = command.snapshot;
  const size = Number(snapshot?.historySize ?? 0n);

  if (!snapshot?.historyPrefixSha256)
    throw new UnsafeCopy("the scan did not record the chat history; scan again to continue natively");

  if (sourceStat(chat).size < size || prefixSha(chat, size) !== snapshot.historyPrefixSha256)
    throw new CommandError("IMPORT_SOURCE_CHANGED", "the source changed since the scan; scan again", false);

  return size;
}

const ADOPT = { claude: adoptClaude, codex: adoptCodex, grok: adoptGrok } as const;

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
