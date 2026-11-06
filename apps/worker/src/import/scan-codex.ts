import { join } from "node:path";
import type { JsonObject } from "@canopy/domain";
import { jsonObject, jsonString } from "../providers/json.ts";
import { codexOrigin, codexPrompt } from "./codex-entries.ts";
import { directoryEntries as listed, headLines, parseLine, snapshotOf, sourceStat, tailLines } from "./read.ts";
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

const ROLLOUT = /^rollout-.*\.jsonl$/;

/**
 * Codex threads: rollouts under `sessions/YYYY/MM/DD` and `archived_sessions` (docs/import.md). The rollout is the
 * source of truth; names come from `session_index.jsonl`. Codex's own SQLite files are never opened.
 */
export function* scanCodex(root: ImportRootPath, context: ScanContext): Generator<SummaryInit> {
  const names = threadNames(root.path);

  for (const [path, archived] of rollouts(root.path)) {
    if (context.full()) return;

    try {
      yield codexSummary(root, context, path, archived, names);
    } catch {
      context.skipped += 1;
    }
  }
}

function* rollouts(home: string): Generator<[string, boolean]> {
  const directoryEntries = (path: string) => listed({ root: home, path });
  const sessions = join(home, "sessions");

  for (const year of directoryEntries(sessions)) {
    if (!year.isDirectory()) continue;

    for (const month of directoryEntries(join(sessions, year.name))) {
      if (!month.isDirectory()) continue;

      for (const day of directoryEntries(join(sessions, year.name, month.name))) {
        if (!day.isDirectory()) continue;
        const dir = join(sessions, year.name, month.name, day.name);

        for (const file of directoryEntries(dir))
          if (file.isFile() && ROLLOUT.test(file.name)) yield [join(dir, file.name), false];
      }
    }
  }

  const archived = join(home, "archived_sessions");

  for (const file of directoryEntries(archived))
    if (file.isFile() && ROLLOUT.test(file.name)) yield [join(archived, file.name), true];
}

/** id → the index entry that names the thread; later lines win (a rename appends). */
function threadNames(home: string): Map<string, JsonObject> {
  const names = new Map<string, JsonObject>();
  const file = { root: home, path: join(home, "session_index.jsonl") };
  let size: number;

  try {
    size = sourceStat(file).size;
  } catch {
    return names;
  }

  for (const line of headLines(file, Math.min(size, SMALL_FILE), size)) {
    const entry = parseLine(line);
    const id = jsonString(entry?.["id"]);
    const name = jsonString(entry?.["thread_name"]);

    if (entry && id && name) names.set(id, entry);
  }

  return names;
}

function codexSummary(
  root: ImportRootPath,
  context: ScanContext,
  path: string,
  archived: boolean,
  names: ReadonlyMap<string, JsonObject>,
): SummaryInit {
  const file = { root: root.path, path };
  const snapshot = snapshotOf(file);
  const size = Number(snapshot.size);
  const small = size <= SMALL_FILE;
  const head = small ? headLines(file, size, size) : headLines(file, HEAD_BYTES, size);

  const lines = [...head, ...(small ? [] : tailLines(file, TAIL_BYTES, size))].flatMap((line) => {
    const parsed = parseLine(line);

    return parsed ? [parsed] : [];
  });

  const meta = jsonObject(lines.find((l) => l["type"] === "session_meta")?.["payload"]);
  const seenItems = lines.some((l) => jsonObject(l["payload"])?.["type"] === "item_completed");
  let started: number | undefined;
  let updated: number | undefined;
  let preview = "";
  let flagged = 0;
  let turns = 0;

  for (const line of lines) {
    const at = timeMs(line["timestamp"]);

    if (at !== undefined) {
      started = started === undefined ? at : Math.min(started, at);
      updated = updated === undefined ? at : Math.max(updated, at);
    }

    if (codexPrompt(line, seenItems) === undefined) continue;
    turns += 1;

    if (!preview) {
      const masked = previewOf(context.masker, line, (l) => codexPrompt(l, seenItems));
      flagged += masked.found;
      preview = masked.text;
    }
  }

  const id = jsonString(meta?.["id"]) || path.slice(path.length - 42, -".jsonl".length);
  const origin = meta ? codexOrigin(meta) : { origin: "unknown", subagent: false, parent: "" };

  return summary(root, context, {
    nativeId: id,
    path,
    snapshot,
    bytes: size,
    cwd: jsonString(meta?.["cwd"]),
    title: previewOf(context.masker, names.get(id), (e) => jsonString(e["thread_name"])).text,
    preview,
    ...((timeMs(meta?.["timestamp"]) ?? started) !== undefined && {
      startedMs: timeMs(meta?.["timestamp"]) ?? started,
    }),
    updatedMs: updated ?? Number(snapshot.modifiedMs),
    turns: small ? turns : 0,
    origin: origin.origin,
    cliVersion: jsonString(meta?.["cli_version"]),
    empty: meta === undefined,
    parentNativeId: origin.parent,
    subagent: origin.subagent,
    flagged,
    gitBranch: jsonString(jsonObject(meta?.["git"])?.["branch"]),
    archived,
  });
}
