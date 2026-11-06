import { join } from "node:path";
import type { JsonObject } from "@canopy/domain";
import { jsonString } from "../providers/json.ts";
import { claudeOrigin, claudeTitle, promptText } from "./claude-entries.ts";
import { directoryEntries, headLines, parseLine, snapshotOf, tailLines } from "./read.ts";
import {
  HEAD_BYTES,
  previewOf,
  SMALL_FILE,
  summary,
  TAIL_BYTES,
  timeMs,
  type ScanContext,
  type SummaryInit,
} from "./scan-types.ts";
import type { ImportRootPath } from "./source-key.ts";

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Claude Code sessions in `<home>/projects/<dir>/<session>.jsonl` (docs/import.md). The directory name is a lossy
 * form of the cwd, so the cwd comes from the entries. Subagent transcripts (`<session>/subagents/`) belong to their
 * session and are not listed apart.
 */
export function* scanClaude(root: ImportRootPath, context: ScanContext): Generator<SummaryInit> {
  const projects = join(root.path, "projects");

  const entries = (path: string) => directoryEntries({ root: root.path, path });

  for (const dir of entries(projects)) {
    if (!dir.isDirectory()) continue;

    for (const file of entries(join(projects, dir.name))) {
      if (context.full()) return;

      if (!file.isFile() || !SESSION_FILE.test(file.name)) continue;

      try {
        yield claudeSummary(root, context, join(projects, dir.name, file.name));
      } catch {
        context.skipped += 1;
      }
    }
  }
}

function claudeSummary(root: ImportRootPath, context: ScanContext, path: string): SummaryInit {
  const file = { root: root.path, path };
  const snapshot = snapshotOf(file);
  const size = Number(snapshot.size);
  const small = size <= SMALL_FILE;
  const head = small ? headLines(file, size, size) : headLines(file, HEAD_BYTES, size);
  const tail = small ? [] : tailLines(file, TAIL_BYTES, size);
  let cwd = "";
  let version = "";
  let entrypoint = "";
  let branch = "";
  let started: number | undefined;
  let updated: number | undefined;
  let preview = "";
  let title: { entry: JsonObject; user: boolean } | undefined;
  let turns = 0;
  let flagged = 0;
  let conversation = false;

  for (const line of [...head, ...tail]) {
    const entry = parseLine(line);

    if (!entry) continue;
    const at = timeMs(entry["timestamp"]);

    if (at !== undefined) {
      started = started === undefined ? at : Math.min(started, at);
      updated = updated === undefined ? at : Math.max(updated, at);
    }

    const named = claudeTitle(entry);

    if (named && (!title || named.user || !title.user)) title = { entry, user: named.user };

    if (entry["type"] !== "user" && entry["type"] !== "assistant") continue;
    conversation = true;

    if (entry["isSidechain"] === true) continue;
    cwd ||= jsonString(entry["cwd"]);
    version ||= jsonString(entry["version"]);
    entrypoint ||= jsonString(entry["entrypoint"]);
    branch ||= jsonString(entry["gitBranch"]);

    if (promptText(entry) === undefined) continue;
    turns += 1;

    if (!preview) {
      const masked = previewOf(context.masker, entry, promptText);
      flagged += masked.found;
      preview = masked.text;
    }
  }

  const name = path.slice(path.lastIndexOf("/") + 1, -".jsonl".length);

  return summary(root, context, {
    nativeId: name,
    path,
    snapshot,
    bytes: size,
    cwd,
    title: previewOf(context.masker, title?.entry, (e) => claudeTitle(e)?.title).text,
    preview,
    ...(started !== undefined && { startedMs: started }),
    updatedMs: updated ?? Number(snapshot.modifiedMs),
    turns: small ? turns : 0,
    origin: claudeOrigin(entrypoint),
    cliVersion: version,
    empty: !conversation,
    flagged,
    gitBranch: branch,
  });
}
