/**
 * Readers of what harness tools return as text (Claude Code Read / Grep / Glob, Codex code-mode cells and
 * apply_patch), so the views can show files, matches and commands instead of the raw text. Each returns
 * undefined (or an empty result) when the text has another shape; the view then shows the text itself.
 */

/** Claude adds reminders for the model to some results; they are not part of the file. */
export function stripReminders(text: string): string {
  return text.replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g, "\n").replace(/\n+$/, "");
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
  const rows = text.split("\n").filter((line) => line.trim() !== "" && !/^Found \d+ (files?|matches?|lines?)/i.test(line) && line !== "--");
  if (mode === "content") {
    const files = new Map<string, MatchLine[]>();
    for (const row of rows) {
      const match = /^(.+?)[:-](\d+)[:-](.*)$/.exec(row);
      const path = match ? match[1]! : (/^(.+?):(.*)$/.exec(row)?.[1] ?? "");
      if (!path) continue;
      const lines = files.get(path) ?? [];
      lines.push(match ? { line: Number(match[2]), text: match[3]! } : { line: undefined, text: row.slice(path.length + 1) });
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
  const body = literal.startsWith("'") ? `"${literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : literal;
  try {
    return JSON.parse(body) as string;
  } catch {
    return literal.slice(1, -1);
  }
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
  | { readonly kind: "command"; readonly output: string; readonly exitCode: number | undefined; readonly running: boolean }
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "text"; readonly text: string };

/**
 * A code-mode cell's result: "Script completed\nWall time 0.1 seconds\nOutput:\n\n{…}". Shell results
 * (`exec_command`: output and exit code) are told apart from other tools' JSON.
 */
export function parseScriptOutput(output: string): ScriptResult | undefined {
  const header = /^Script (completed|failed[^\n]*|error[^\n]*)\s*\n(?:Wall time ([\d.]+) seconds\s*\n)?Output:\s*\n?/i.exec(output);
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
  return { status, failed: !status.startsWith("completed"), wallSeconds: header[2] ? Number(header[2]) : undefined, parts };
}

function jsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function commandResult(value: unknown): ScriptPart | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["output"] !== "string" || !("wall_time_seconds" in record || "exit_code" in record || "chunk_id" in record)) return undefined;
  return {
    kind: "command",
    output: record["output"],
    exitCode: typeof record["exit_code"] === "number" ? record["exit_code"] : undefined,
    // A session id without an exit code: the process still runs (it continues in the background).
    running: typeof record["exit_code"] !== "number" && record["session_id"] !== undefined,
  };
}

export interface PatchFile {
  readonly path: string;
  readonly kind: "add" | "update" | "delete" | "move";
  readonly movePath: string;
  readonly diff: string;
}

/** Codex apply_patch input ("*** Begin Patch / *** Update File: a.ts / @@ / -old / +new / *** End Patch") as files with diffs. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: { path: string; kind: PatchFile["kind"]; movePath: string; lines: string[] } | undefined;
  const push = () => {
    if (current) files.push({ path: current.path, kind: current.kind, movePath: current.movePath, diff: current.lines.join("\n") });
  };
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      push();
      current = { path: header[2]!.trim(), kind: header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update", movePath: "", lines: [] };
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
  try {
    const blocks: unknown = JSON.parse(text);
    if (!Array.isArray(blocks) || blocks.length === 0) return output;
    const texts = blocks.map((block: unknown) => {
      if (!block || typeof block !== "object") return undefined;
      const record = block as Record<string, unknown>;
      if (record["type"] === "text" && typeof record["text"] === "string") return record["text"];
      return typeof record["type"] === "string" && record["type"] !== "text" ? `[${record["type"]}]` : undefined;
    });
    return texts.every((t) => t !== undefined) ? texts.join("\n\n") : output;
  } catch {
    return output;
  }
}

export interface WebLink {
  readonly title: string;
  readonly url: string;
}

/**
 * Web search results: a JSON list of `{title, url}`, or Claude's text with a `Links: [...]` line; the
 * links and whatever text remains (the summary).
 */
export function parseWebResults(output: string): { links: WebLink[]; text: string } {
  const toLinks = (value: unknown): WebLink[] =>
    Array.isArray(value)
      ? value.flatMap((entry: unknown) => {
          if (!entry || typeof entry !== "object") return [];
          const record = entry as Record<string, unknown>;
          const url = typeof record["url"] === "string" ? record["url"] : "";
          return url ? [{ url, title: typeof record["title"] === "string" && record["title"] ? record["title"] : shortUrl(url) }] : [];
        })
      : [];
  const text = stripReminders(output).trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return { links: toLinks(parsed), text: "" };
  } catch {
    // Text: look for the links line below.
  }
  const links: WebLink[] = [];
  const rest = text
    .replace(/^Links:\s*(\[.*\])\s*$/gm, (_, json: string) => {
      try {
        links.push(...toLinks(JSON.parse(json)));
        return "";
      } catch {
        return _;
      }
    })
    .replace(/^Web search results for query:.*$/m, "")
    .trim();
  return { links, text: rest };
}
