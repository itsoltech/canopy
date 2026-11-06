/**
 * Readers of what harness tools return as text (Claude Code Read / Grep / Glob, Codex code-mode cells and
 * apply_patch), so the views can show files, matches and commands instead of the raw text. Each returns
 * undefined (or an empty result) when the text has another shape; the view then shows the text itself.
 */

import { isJsonArray, isJsonObject, isNumber, isString, objectsOf, parseJson, str, type JsonValue } from "../json.ts";

/** Claude adds reminders for the model to some results and wraps errors in a tag; neither is for people. */
export function stripReminders(text: string): string {
  return text
    .replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g, "\n")
    .replace(/<\/?tool_use_error>/g, "")
    .replace(/\n+$/, "");
}

export interface NumberedText {
  /** Line number of the first line. */
  readonly start: number;
  readonly lines: readonly string[];
}

/**
 * Claude Read's `cat -n` output ("     1\tcode" or "     1→code"): the file's lines and where they start.
 * Undefined when most lines lack a number (another tool's text, an error).
 */
export function parseNumberedLines(output: string): NumberedText | undefined {
  const text = stripReminders(output);

  if (!text) return undefined;
  const raw = text.split("\n");
  const pattern = /^\s*(\d+)(?:\t|→)(.*)$/;
  const lines: string[] = [];
  let start = 0;

  for (const line of raw) {
    const match = pattern.exec(line);

    if (!match) return undefined;

    if (lines.length === 0) start = Number(match[1]);
    lines.push(match[2]!);
  }

  // A file ending in a newline reads as one more, empty, numbered line.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();

  return { start, lines };
}

export interface MatchLine {
  readonly line: number | undefined;
  readonly text: string;
}

export interface FileMatches {
  readonly path: string;
  /** Matches in the file (count mode, or the lines found). */
  readonly count: number | undefined;
  readonly lines: readonly MatchLine[];
}

/**
 * Grep results in any output mode: a file list ("Found 3 files\na.ts\nb.ts"), counts ("a.ts:4") or
 * matching lines ("a.ts:12:text", "a.ts-13-context"), grouped by file in order of appearance.
 */
export function parseGrepOutput(output: string, mode: string): FileMatches[] {
  const text = stripReminders(output).trim();

  if (!text || /^No (files|matches) found/i.test(text)) return [];

  const rows = text
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^Found \d+ (files?|matches?|lines?)/i.test(line) && line !== "--");

  if (mode === "content") {
    const files = new Map<string, MatchLine[]>();

    for (const row of rows) {
      const match = /^(.+?)[:-](\d+)[:-](.*)$/.exec(row);
      const path = match ? match[1]! : (/^(.+?):(.*)$/.exec(row)?.[1] ?? "");

      if (!path) continue;
      const lines = files.get(path) ?? [];
      lines.push(
        match ? { line: Number(match[2]), text: match[3]! } : { line: undefined, text: row.slice(path.length + 1) },
      );
      files.set(path, lines);
    }

    return [...files].map(([path, lines]) => ({ path, count: lines.length, lines }));
  }

  if (mode === "count") {
    return rows.flatMap((row) => {
      const match = /^(.+):(\d+)$/.exec(row);

      return match ? [{ path: match[1]!, count: Number(match[2]), lines: [] }] : [];
    });
  }

  return rows.map((path) => ({ path: path.trim(), count: undefined, lines: [] }));
}

/** Glob / LS output: one path per line; "No files found" and notes are left out. */
export function parseFileList(output: string): string[] {
  const text = stripReminders(output).trim();

  if (!text || /^No files found/i.test(text)) return [];

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^\(Results are truncated/i.test(line) && !/^Found \d+ files?/i.test(line));
}

export interface ScriptCall {
  /** Tool the script calls (`exec_command`, `list_agents`, …). */
  readonly tool: string;
  /** For shell tools: the command it runs. */
  readonly command: string | undefined;
}

/** The tools a Codex code-mode cell calls (`await tools.exec_command({cmd: "…"})`), in order. */
export function parseScriptCalls(code: string): ScriptCall[] {
  const starts = [...code.matchAll(/\btools\.(\w+)\s*\(/g)];

  return starts.map((match, index) => {
    // The call's own text: up to the next tool call.
    const own = code.slice(match.index, starts[index + 1]?.index ?? code.length);
    const literal = /["']?\b(?:cmd|command)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(own);

    return { tool: match[1]!, command: literal ? stringLiteral(literal[1]!) : undefined };
  });
}

function stringLiteral(literal: string): string {
  const body = literal.startsWith("'")
    ? `"${literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
    : literal;

  const parsed = parseJson(body);

  return isString(parsed) ? parsed : literal.slice(1, -1);
}

export interface ScriptResult {
  /** "completed", or the failure line ("failed: …"). */
  readonly status: string;
  readonly failed: boolean;
  readonly wallSeconds: number | undefined;
  /** What the script printed: JSON values (tool results) and text, in order. */
  readonly parts: readonly ScriptPart[];
}

export type ScriptPart =
  | {
      readonly kind: "command";
      readonly output: string;
      readonly exitCode: number | undefined;
      readonly running: boolean;
    }
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "text"; readonly text: string };

/**
 * A code-mode cell's result: "Script completed\nWall time 0.1 seconds\nOutput:\n\n{…}". Shell results
 * (`exec_command`: output and exit code) are told apart from other tools' JSON.
 */
export function parseScriptOutput(output: string): ScriptResult | undefined {
  const header =
    /^Script (completed|failed[^\n]*|error[^\n]*)\s*\n(?:Wall time ([\d.]+) seconds\s*\n)?Output:\s*\n?/i.exec(output);

  if (!header) return undefined;
  const body = output.slice(header[0].length);
  const parts: ScriptPart[] = [];
  let text: string[] = [];

  const flush = () => {
    const joined = text.join("\n").trim();

    if (joined) parts.push({ kind: "text", text: joined });
    text = [];
  };

  for (const line of body.split("\n")) {
    const value = jsonLine(line);

    if (value === undefined) {
      text.push(line);
      continue;
    }

    flush();
    parts.push(commandResult(value) ?? { kind: "json", value });
  }

  flush();
  const status = header[1]!.toLowerCase();

  return {
    status,
    failed: !status.startsWith("completed"),
    wallSeconds: header[2] ? Number(header[2]) : undefined,
    parts,
  };
}

function jsonLine(line: string): JsonValue | undefined {
  const trimmed = line.trim();

  return /^[[{]/.test(trimmed) ? parseJson(trimmed) : undefined;
}

function commandResult(record: JsonValue): ScriptPart | undefined {
  if (!isJsonObject(record)) return undefined;
  const output = record["output"];

  if (!isString(output) || !("wall_time_seconds" in record || "exit_code" in record || "chunk_id" in record))
    return undefined;

  const exitCode = record["exit_code"];

  return {
    kind: "command",
    output,
    exitCode: isNumber(exitCode) ? exitCode : undefined,
    // A session id without an exit code: the process still runs (it continues in the background).
    running: !isNumber(exitCode) && record["session_id"] !== undefined,
  };
}

export interface PatchFile {
  readonly path: string;
  readonly kind: "add" | "update" | "delete" | "move";
  readonly movePath: string;
  readonly diff: string;
}

const PATCH_KINDS = new Map<string, PatchFile["kind"]>([
  ["Add", "add"],
  ["Delete", "delete"],
]);

/** Codex apply_patch input ("*** Begin Patch / *** Update File: a.ts / @@ / -old / +new / *** End Patch") as files with diffs. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: { path: string; kind: PatchFile["kind"]; movePath: string; lines: string[] } | undefined;

  const push = () => {
    if (current)
      files.push({
        path: current.path,
        kind: current.kind,
        movePath: current.movePath,
        diff: current.lines.join("\n"),
      });
  };

  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);

    if (header) {
      push();
      current = {
        path: header[2]!.trim(),
        kind: PATCH_KINDS.get(header[1]!) ?? "update",
        movePath: "",
        lines: [],
      };
      continue;
    }

    const move = /^\*\*\* Move to: (.+)$/.exec(line);

    if (move && current) {
      current.kind = "move";
      current.movePath = move[1]!.trim();
      continue;
    }

    if (/^\*\*\* (Begin|End) Patch/.test(line) || line.startsWith("*** End of File")) continue;
    current?.lines.push(line);
  }

  push();

  return files;
}

/** A replacement as a diff: the old text removed, the new text added. */
export function replacementDiff(before: string, after: string): string {
  const prefix = (text: string, mark: string) => (text ? text.split("\n").map((line) => `${mark}${line}`) : []);

  return [...prefix(before, "-"), ...prefix(after, "+")].join("\n");
}

/** Host and path of a URL for a title ("docs.github.com/en/rest"); the text itself when it is no URL. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");

    return `${parsed.host.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

/**
 * MCP results come as content blocks (`[{"type":"text","text":"…"}]`): their text, joined. Anything else
 * (plain text, other JSON) is returned as it is.
 */
export function unwrapContent(output: string): string {
  const text = output.trim();

  if (!text.startsWith("[")) return output;

  const blocks = parseJson(text);

  if (!isJsonArray(blocks) || blocks.length === 0) return output;

  const texts = blocks.map((block) => {
    if (!isJsonObject(block)) return undefined;
    const type = block["type"];
    const blockText = block["text"];

    if (type === "text" && isString(blockText)) return blockText;

    return isString(type) && type !== "text" ? `[${type}]` : undefined;
  });

  return texts.every((t) => t !== undefined) ? texts.join("\n\n") : output;
}

export interface WebLink {
  readonly title: string;
  readonly url: string;
}

export interface WebResults {
  readonly links: WebLink[];
  readonly text: string;
}

/**
 * Web search results: a JSON list of `{title, url}`, or Claude's text with a `Links: [...]` line; the
 * links and whatever text remains (the summary).
 */
export function parseWebResults(output: string): WebResults {
  const toLinks = (value: JsonValue): WebLink[] =>
    objectsOf(value).flatMap((record) => {
      const url = str(record["url"]);

      return url ? [{ url, title: str(record["title"]) || shortUrl(url) }] : [];
    });

  const text = stripReminders(output).trim();
  const parsed = parseJson(text);

  // Text: look for the links line below.
  if (isJsonArray(parsed)) return { links: toLinks(parsed), text: "" };

  const links: WebLink[] = [];

  const rest = text
    .replace(/^Links:\s*(\[.*\])\s*$/gm, (line, json: string) => {
      const list = parseJson(json);

      if (list === undefined) return line;
      links.push(...toLinks(list));

      return "";
    })
    .replace(/^Web search results for query:.*$/m, "")
    .trim();

  return { links, text: rest };
}
