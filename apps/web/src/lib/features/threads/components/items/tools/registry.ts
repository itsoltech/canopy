import { basename, parseObject, str } from "#lib/shared/format.ts";
import { humanizeEnum, humanizeServer, humanizeToolName, isOpaqueId, plural } from "#lib/shared/humanize.ts";
import type { IconName } from "#lib/shared/ui/icons.ts";
import { parseFileList, parseGrepOutput, parseNumberedLines, parsePatch, parseScriptCalls, parseScriptOutput, shortUrl } from "./parse.ts";

/**
 * How a tool call reads on the timeline, by tool: its one-line title (verb, subject, a short detail on the
 * right) and which body shows its input and result (`ToolCallView` maps bodies to components). Tools
 * without an entry, MCP tools included, get the generic look: their name in words, the first short
 * argument as the subject and the structured input and result.
 */

/** Views of a call's input and result; `generic` is the structured fallback. */
export type ToolBody = "read" | "search" | "files" | "fetch" | "web-search" | "script" | "todo" | "edit" | "patch" | "shell" | "markdown" | "generic";

export interface ToolCallFacts {
  /** MCP server or dynamic tool namespace; empty for built-in tools. */
  readonly server: string;
  readonly name: string;
  readonly inputJson: string;
  readonly output: string;
  readonly isError: boolean;
  /** Still running: titles say what it is doing ("Reading"). */
  readonly running: boolean;
}

export interface ToolLook {
  /** What it did: "Read", "Searched for", "GitHub · Create issue". */
  readonly title: string;
  /** What it did it to (a file name, a pattern, a URL); "" when nothing stands out. */
  readonly subject: string;
  /** The subject in full (a path, the whole command), for its tooltip. */
  readonly subjectTitle: string;
  /** The subject is code or a path (monospace). */
  readonly mono: boolean;
  /** A short fact on the right ("lines 10–49", "12 files", "3 of 5 done"). */
  readonly detail: string;
  readonly icon: IconName;
  readonly body: ToolBody;
}

type Describe = (call: ToolCallFacts, input: Record<string, unknown>) => Partial<ToolLook> & Pick<ToolLook, "title" | "body">;

const verb = (call: ToolCallFacts, doing: string, done: string) => (call.running ? doing : done);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const path = (value: string) => ({ subject: basename(value), subjectTitle: value, mono: true });

function readDetail(call: ToolCallFacts, input: Record<string, unknown>): string {
  const offset = num(input["offset"]);
  const limit = num(input["limit"]);
  if (offset !== undefined || limit !== undefined) {
    const first = offset ?? 1;
    return limit !== undefined ? `lines ${first}–${first + limit - 1}` : `from line ${first}`;
  }
  const pages = str(input["pages"]);
  if (pages) return `pages ${pages}`;
  const parsed = call.running ? undefined : parseNumberedLines(call.output);
  return parsed ? plural(parsed.lines.length, "line") : "";
}

function grepDetail(call: ToolCallFacts, input: Record<string, unknown>): string {
  if (call.running || call.isError) return "";
  const mode = str(input["output_mode"]) || "files_with_matches";
  const files = parseGrepOutput(call.output, mode);
  if (files.length === 0) return "no matches";
  if (mode === "files_with_matches") return plural(files.length, "file");
  const matches = files.reduce((sum, file) => sum + (file.count ?? 0), 0);
  return `${plural(matches, "match", "matches")} in ${plural(files.length, "file")}`;
}

function todoDetail(input: Record<string, unknown>): string {
  const items = todos(input);
  if (items.length === 0) return "";
  return `${items.filter((t) => t.status === "completed").length} of ${items.length} done`;
}

/** TodoWrite `todos` or Codex update_plan `plan`, as checklist steps. */
export function todos(input: Record<string, unknown>): { text: string; status: string }[] {
  const list = Array.isArray(input["todos"]) ? input["todos"] : Array.isArray(input["plan"]) ? input["plan"] : [];
  return list.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const text = str(record["content"]) || str(record["step"]) || str(record["text"]);
    return text ? [{ text, status: str(record["status"]) }] : [];
  });
}

/** The command of a shell-like call (`cmd`, `command` as text or argv). */
export function shellCommand(input: Record<string, unknown>): string {
  const command = input["cmd"] ?? input["command"];
  if (Array.isArray(command)) return command.filter((part) => typeof part === "string").join(" ");
  return str(command);
}

function scriptSubject(call: ToolCallFacts, input: Record<string, unknown>): Partial<ToolLook> {
  const calls = parseScriptCalls(str(input["code"]));
  const first = calls[0];
  const wall = call.running ? undefined : parseScriptOutput(call.output)?.wallSeconds;
  const detail = [calls.length > 1 ? plural(calls.length, "call") : "", wall !== undefined && wall >= 1 ? `${wall.toFixed(wall < 10 ? 1 : 0)}s` : ""].filter(Boolean).join(" · ");
  if (!first) return { detail };
  const subject = first.command ?? humanizeToolName(first.tool);
  return { subject, subjectTitle: calls.map((c) => c.command ?? humanizeToolName(c.tool)).join("\n"), mono: first.command !== undefined, detail };
}

const SHELL: Describe = (call, input) => {
  const command = shellCommand(input);
  return { title: verb(call, "Running", "Ran"), subject: command, subjectTitle: command, mono: true, icon: "command-line", body: "shell" };
};

const EDIT: Describe = (call, input) => ({
  title: verb(call, "Editing", "Edited"),
  ...path(str(input["file_path"]) || str(input["notebook_path"])),
  icon: "pencil-square",
  body: "edit",
});

const TODO: Describe = (call, input) => ({ title: verb(call, "Updating the to-do list", "Updated the to-do list"), detail: todoDetail(input), icon: "queue-list", body: "todo" });

const REGISTRY: Record<string, Describe> = {
  // Claude Code
  Read: (call, input) => ({ title: verb(call, "Reading", "Read"), ...path(str(input["file_path"])), detail: readDetail(call, input), icon: "document-text", body: "read" }),
  Grep: (call, input) => ({
    title: verb(call, "Searching for", "Searched for"),
    subject: str(input["pattern"]),
    subjectTitle: str(input["pattern"]),
    mono: true,
    detail: grepDetail(call, input),
    icon: "magnifying-glass",
    body: "search",
  }),
  Glob: (call, input) => {
    const files = call.running || call.isError ? undefined : parseFileList(call.output);
    return {
      title: verb(call, "Finding files", "Found files"),
      subject: str(input["pattern"]),
      subjectTitle: str(input["pattern"]),
      mono: true,
      detail: files ? (files.length > 0 ? plural(files.length, "file") : "none") : "",
      icon: "folder-open",
      body: "files",
    };
  },
  LS: (call, input) => ({ title: verb(call, "Listing", "Listed"), ...path(str(input["path"])), icon: "folder-open", body: "files" }),
  WebFetch: (call, input) => ({ title: verb(call, "Fetching", "Fetched"), subject: shortUrl(str(input["url"])), subjectTitle: str(input["url"]), icon: "globe-alt", body: "fetch" }),
  WebSearch: (call, input) => ({ title: verb(call, "Searching the web for", "Searched the web for"), subject: str(input["query"]), icon: "globe-alt", body: "web-search" }),
  TodoWrite: TODO,
  Write: (call, input) => ({ title: verb(call, "Writing", "Wrote"), ...path(str(input["file_path"])), icon: "pencil-square", body: "edit" }),
  Edit: EDIT,
  MultiEdit: (call, input) => ({ ...EDIT(call, input), detail: Array.isArray(input["edits"]) ? plural(input["edits"].length, "edit") : "" }),
  NotebookEdit: EDIT,
  Skill: (call, input) => ({ title: verb(call, "Using the skill", "Used the skill"), subject: str(input["skill"]) || str(input["command"]), icon: "bolt", body: "markdown" }),
  ToolSearch: (call, input) => ({ title: verb(call, "Looking up tools", "Looked up tools"), subject: str(input["query"]), icon: "magnifying-glass", body: "generic" }),
  ExitPlanMode: (call) => ({ title: verb(call, "Proposing a plan", "Proposed a plan"), icon: "queue-list", body: "markdown" }),
  BashOutput: (call) => ({ title: verb(call, "Reading background output", "Read background output"), icon: "command-line", body: "generic" }),
  TaskOutput: (call) => ({ title: verb(call, "Reading background output", "Read background output"), icon: "command-line", body: "generic" }),
  KillShell: (call) => ({ title: verb(call, "Stopping a background task", "Stopped a background task"), icon: "stop", body: "generic" }),
  KillBash: (call) => ({ title: verb(call, "Stopping a background task", "Stopped a background task"), icon: "stop", body: "generic" }),
  TaskStop: (call) => ({ title: verb(call, "Stopping a background task", "Stopped a background task"), icon: "stop", body: "generic" }),
  Bash: SHELL,
  // Codex
  exec: (call, input) => ({ title: verb(call, "Running a script", "Ran a script"), icon: "code-bracket", body: "script", ...scriptSubject(call, input) }),
  wait: (call) => ({ title: verb(call, "Waiting for the script", "Waited for the script"), icon: "clock", body: "script" }),
  exec_command: SHELL,
  shell: SHELL,
  shell_command: SHELL,
  local_shell: SHELL,
  apply_patch: (call, input) => {
    const files = parsePatch(str(input["input"]) || str(input["patch"]));
    return {
      title: verb(call, "Editing", "Edited"),
      subject: files.map((f) => basename(f.path)).join(", "),
      subjectTitle: files.map((f) => f.path).join("\n"),
      mono: true,
      detail: files.length > 1 ? plural(files.length, "file") : "",
      icon: "pencil-square",
      body: "patch",
    };
  },
  update_plan: TODO,
  web_search: (call, input) => ({ title: verb(call, "Searching the web for", "Searched the web for"), subject: str(input["query"]), icon: "globe-alt", body: "web-search" }),
  view_image: (call, input) => ({ title: verb(call, "Viewing an image", "Viewed an image"), ...path(str(input["path"])), icon: "photo", body: "generic" }),
  get_goal: (call) => ({ title: verb(call, "Checking the goal", "Checked the goal"), icon: "flag", body: "generic" }),
  create_goal: (call) => ({ title: verb(call, "Setting a goal", "Set a goal"), icon: "flag", body: "generic" }),
  update_goal: (call, input) => ({ title: verb(call, "Updating the goal", "Updated the goal"), subject: humanizeEnum(str(input["status"])), icon: "flag", body: "generic" }),
};

/** The first short, readable argument (not an id, not a flag): what a call without an entry is about. */
export function hintOf(input: Record<string, unknown>): string {
  for (const value of Object.values(input)) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text && text.length < 200 && !text.includes("\n") && !isOpaqueId(text)) return text;
  }
  return "";
}

/** The look of a tool call: its registry entry, or the generic one. */
export function describeTool(call: ToolCallFacts): ToolLook {
  const input = parseObject(call.inputJson);
  // MCP tools are matched by name only within the built-in set (no server).
  const entry = call.server ? undefined : REGISTRY[call.name];
  const base: ToolLook = {
    title: call.server ? `${humanizeServer(call.server)} · ${humanizeToolName(call.name)}` : humanizeToolName(call.name),
    subject: "",
    subjectTitle: "",
    mono: false,
    detail: "",
    icon: call.server ? "code-bracket" : "wrench",
    body: "generic",
  };
  if (!entry) {
    const hint = hintOf(input);
    return { ...base, subject: hint, subjectTitle: hint };
  }
  const look = { ...base, ...entry(call, input) };
  return { ...look, subjectTitle: look.subjectTitle || look.subject };
}

/** Known tool names (for tests and the dev gallery). */
export const registeredTools = (): string[] => Object.keys(REGISTRY);
