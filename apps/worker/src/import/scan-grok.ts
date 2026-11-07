import { join } from "node:path";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { decodeJson, isJsonObject, isNumber, jsonObject, jsonString } from "../providers/json.ts";
import {
  directoryEntries,
  headLines,
  parseLine,
  readSourceText,
  snapshotOf,
  sourceExists,
  sourceStat,
  type SourceFile,
} from "./read.ts";
import {
  HEAD_BYTES,
  previewOf,
  SMALL_FILE,
  summary,
  timeMs,
  type ScanContext,
  type SummaryInit,
} from "./scan-types.ts";
import type { ImportRootPath } from "./source-key.ts";

/**
 * Grok sessions: `sessions/<encoded cwd>/<session id>/` (docs/import.md). `chat_history.jsonl` is what the model
 * saw, `updates.jsonl` the ACP updates, `summary.json` the title and times. A directory without either history
 * file is listed as empty. `session_search.sqlite` (full text of conversations) is never opened.
 */
export function* scanGrok(root: ImportRootPath, context: ScanContext): Generator<SummaryInit> {
  const sessions = join(root.path, "sessions");

  for (const group of directoryEntries({ root: root.path, path: sessions })) {
    if (!group.isDirectory()) continue;

    for (const session of directoryEntries({ root: root.path, path: join(sessions, group.name) })) {
      if (context.full()) return;

      if (!session.isDirectory()) continue;

      try {
        yield grokSummary(root, context, join(sessions, group.name, session.name), group.name);
      } catch {
        context.skipped += 1;
      }
    }
  }
}

const HISTORY = "chat_history.jsonl";
const UPDATES = "updates.jsonl";

/** User text without the tags Grok wraps a prompt in. */
export function grokPromptText(text: string): string {
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);

  return (query ? query[1]! : text).trim();
}

function grokSummary(root: ImportRootPath, context: ScanContext, dir: string, group: string): SummaryInit {
  const at = (name: string): SourceFile => ({ root: root.path, path: join(dir, name) });
  const main = sourceExists(at(HISTORY)) ? at(HISTORY) : at(UPDATES);
  const files = directoryEntries({ root: root.path, path: dir }).filter((f) => f.isFile() && !f.name.endsWith(".lock"));
  const bytes = files.reduce((sum, f) => sum + sourceStat(at(f.name)).size, 0);
  const meta = readJson(at("summary.json"));
  const context0 = readJson(at("prompt_context.json"));
  const empty = !sourceExists(main);
  const size = empty ? 0 : sourceStat(main).size;
  let preview = "";
  let flagged = 0;
  let turns = 0;

  if (!empty) {
    const lines = headLines(main, size <= SMALL_FILE ? size : HEAD_BYTES, size);

    for (const line of lines) {
      const entry = parseLine(line);
      const history = main.path.endsWith(HISTORY);

      if (promptOf(entry, history) === undefined) continue;
      turns += 1;

      if (!preview) {
        const masked = previewOf(context.masker, entry, (e) => promptOf(e, history));
        flagged += masked.found;
        preview = masked.text;
      }
    }
  }

  const cwd = jsonString(context0?.["working_directory"]) || decodeGroup(group);
  const nonInteractive = context0?.["is_non_interactive"] === true || meta?.["session_kind"] === "headless";

  const snapshot = empty
    ? { size: 0n, modifiedMs: BigInt(Math.trunc(modifiedMs(at("summary.json")))), prefixSha256: "" }
    : snapshotOf(main);

  return summary(root, context, {
    nativeId: dir.slice(dir.lastIndexOf("/") + 1),
    path: dir,
    snapshot,
    bytes,
    cwd,
    title: previewOf(context.masker, meta, (m) => jsonString(m["generated_title"])).text,
    preview,
    ...(timeMs(meta?.["created_at"]) !== undefined && { startedMs: timeMs(meta?.["created_at"]) }),
    updatedMs: timeMs(meta?.["last_active_at"]) ?? timeMs(meta?.["updated_at"]) ?? Number(snapshot.modifiedMs),
    turns: size <= SMALL_FILE ? turns : 0,
    origin: nonInteractive ? "exec" : "cli",
    cliVersion: "",
    format: historyFormat(meta),
    empty,
    flagged,
    gitBranch: jsonString(meta?.["head_branch"]),
  });
}

function promptOf(entry: JsonObject | undefined, history: boolean): string | undefined {
  if (!entry) return undefined;

  if (history) {
    if (entry["type"] !== "user" || !isNumber(entry["prompt_index"]) || entry["synthetic_reason"]) return undefined;
    const content = entry["content"];

    const text = Array.isArray(content)
      ? content.map((p) => (isJsonObject(p) ? jsonString(p["text"]) : "")).join("\n")
      : jsonString(content);

    return grokPromptText(text);
  }

  const update = jsonObject(jsonObject(entry["params"])?.["update"]);

  if (update?.["sessionUpdate"] !== "user_message_chunk") return undefined;

  return jsonString(jsonObject(update["content"])?.["text"]).trim();
}

/** Grok writes the version of its history format (`chat_format_version`), not the CLI version, per session. */
function historyFormat(meta: JsonObject | undefined): "supported" | "newer" | "unknown" {
  const version = meta?.["chat_format_version"];

  if (!isNumber(version)) return "unknown";

  return version <= 1 ? "supported" : "newer";
}

function decodeGroup(group: string): string {
  try {
    const decoded = decodeURIComponent(group);

    return decoded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function readJson(file: SourceFile): JsonObject | undefined {
  const text = readSourceText(file, 4 * 1024 ** 2);

  if (text === undefined) return undefined;

  try {
    const value: JsonValue = decodeJson(JSON.parse(text));

    return jsonObject(value);
  } catch {
    return undefined;
  }
}

function modifiedMs(file: SourceFile): number {
  try {
    return sourceStat(file).mtimeMs;
  } catch {
    return 0;
  }
}
