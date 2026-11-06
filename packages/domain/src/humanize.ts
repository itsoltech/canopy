/**
 * Internal values in words a person reads: keys (`file_path`, `threadId`), enum keys
 * (`PERMISSION_MODE_FULL_AUTO`, `full_auto`, `user_message`), tool names (`read_thread`, `WebFetch`) and
 * opaque ids (uuids, provider call ids), which the UI keeps out of sight (tooltips, copy actions).
 * One module, so every view says the same thing for the same value.
 */
import { isPlatformServer } from "./platform.ts";

/** Words that keep their own spelling inside a label. */
const SPELLING = new Map<string, string>([
  ["id", "ID"],
  ["ids", "IDs"],
  ["url", "URL"],
  ["urls", "URLs"],
  ["uri", "URI"],
  ["api", "API"],
  ["json", "JSON"],
  ["mcp", "MCP"],
  ["pid", "PID"],
  ["ui", "UI"],
  ["ai", "AI"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["http", "HTTP"],
  ["https", "HTTPS"],
  ["sql", "SQL"],
  ["cli", "CLI"],
  ["ssh", "SSH"],
  ["cwd", "CWD"],
  ["os", "OS"],
  ["ip", "IP"],
  ["llm", "LLM"],
  ["pr", "PR"],
  ["ci", "CI"],
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["openai", "OpenAI"],
  ["ok", "OK"],
  ["utc", "UTC"],
  ["iso", "ISO"],
  ["js", "JS"],
  ["ts", "TS"],
]);

/** Whole keys with a better name than their words. */
const KEY_LABELS = new Map<string, string>([
  ["cwd", "Working directory"],
  ["workdir", "Working directory"],
  ["file_path", "File"],
  ["notebook_path", "Notebook"],
  ["old_string", "Replace"],
  ["new_string", "With"],
  ["replace_all", "Replace all"],
  ["head_limit", "Limit"],
  ["output_mode", "Show"],
  ["max_output_tokens", "Output limit"],
  ["yield_time_ms", "Wait"],
  ["timeout_seconds", "Timeout"],
  ["delay_seconds", "Delay"],
  ["max_runs", "Run limit"],
  ["next_run_at", "Next run"],
  ["run_at", "Runs at"],
  ["last_message", "Last message"],
  ["last_turn", "Last turn"],
  ["permission_mode", "Permissions"],
  ["waiting_for_parent", "Waiting for the parent agent"],
  ["waiting_for_user", "Waiting for you"],
  ["queued_turns", "Queued turns"],
]);

/** Proto enum prefixes, longest first, stripped from SCREAMING keys (`PERMISSION_MODE_FULL_AUTO` → `FULL_AUTO`). */
const ENUM_PREFIXES = [
  "PROVIDER_PROFILE_KIND_",
  "BACKGROUND_TASK_KIND_",
  "ITEM_DELTA_FIELD_",
  "TURN_END_SOURCE_",
  "INTERACTION_KIND_",
  "PERMISSION_MODE_",
  "GOAL_DIRECTIVE_",
  "THREAD_STATUS_",
  "WORKER_STATE_",
  "DEVICE_LOGIN_",
  "NOTICE_LEVEL_",
  "TURN_OUTCOME_",
  "TURN_ORIGIN_",
  "ITEM_STATUS_",
  "GOAL_STATUS_",
  "PROVIDER_",
];

/** Splits snake_case, kebab-case, camelCase, PascalCase, SCREAMING_CASE and `mcp__server__tool` into words. */
export function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.:/]+/)
    .filter(Boolean);
}

function phrase(parts: readonly string[]): string {
  return parts
    .map((word, index) => {
      const lower = word.toLowerCase();
      const spelled = SPELLING.get(lower);

      if (spelled) return spelled;

      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** A field name as a label: `file_path` → "File", `afterSeq` → "After seq", `thread_ids` → "Thread IDs". */
export function humanizeKey(key: string): string {
  const known = KEY_LABELS.get(key) ?? KEY_LABELS.get(words(key).join("_").toLowerCase());

  return known ?? phrase(words(key));
}

/**
 * An enum value in words: `PERMISSION_MODE_FULL_AUTO` / `FULL_AUTO` / `full_auto` → "Full auto",
 * `user_message` → "User message"; `*_UNSPECIFIED` → "" (nothing to say).
 */
export function humanizeEnum(value: string): string {
  if (!value) return "";
  let key = value.trim();

  if (/^[A-Z0-9_]+$/.test(key)) {
    const prefix = ENUM_PREFIXES.find((p) => key.startsWith(p) && key.length > p.length);

    if (prefix) key = key.slice(prefix.length);

    if (key === "UNSPECIFIED") return "";
  }

  return phrase(words(key));
}

/** A tool's name as a person says it: `read_thread` → "Read thread", `WebFetch` → "Web fetch", `mcp__github__get_issue` → "GitHub · Get issue". */
export function humanizeToolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);

  if (mcp) return `${humanizeServer(mcp[1]!)} · ${phrase(words(mcp[2]!))}`;

  return phrase(words(name));
}

/** An MCP server's name: `github` → "GitHub", `chrome-devtools` → "Chrome devtools", `canopy` → "Canopy". */
export function humanizeServer(server: string): string {
  if (isPlatformServer(server)) return "Canopy";

  return phrase(words(server));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:~[0-9a-f]{16})?$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/**
 * A value only machines read: a uuid, a provider call id (`call_…`, `toolu_…`, `exec-…`), a long hex or
 * base62 token. Shown to people only behind a tooltip or a copy action.
 */
export function isOpaqueId(value: string): boolean {
  if (UUID.test(value)) return true;

  if (/^(call|toolu|exec|msg|req|run|item|chatcmpl|resp)[-_][A-Za-z0-9-]{8,}$/.test(value)) return true;

  if (/^[0-9a-f]{16,}$/i.test(value)) return true;

  // One long token of letters and digits mixed (no spaces, no path or dot), e.g. ULIDs and API ids.
  return /^[A-Za-z0-9]{20,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

/** A key that names an id field (`id`, `thread_id`, `requestId`, `thread_ids`). */
export const isIdKey = (key: string): boolean => /(^|_)ids?$/i.test(key) || /[a-z](Id|Ids|ID)$/.test(key);

/** An ISO 8601 date-time (`2026-11-01T18:21:00.781Z`). */
export const isIsoDateTime = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value);

/**
 * An enum-like token: one word of lower snake case (`full_auto`, `user_message`) or SCREAMING case
 * (`ITEM_STATUS_COMPLETED`), as opposed to prose, paths and code.
 */
export const isEnumToken = (value: string): boolean =>
  /^[a-z]+(_[a-z0-9]+)+$/.test(value) || /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(value);

/** "1 file", "3 files". */
export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Seconds as a person says them: 60 → "1 minute", 5400 → "1 hour 30 minutes", 45 → "45 seconds". */
export function humanizeSeconds(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "";
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.round(total % 60);

  const parts = [
    days && plural(days, "day"),
    hours && plural(hours, "hour"),
    minutes && plural(minutes, "minute"),
    !days && !hours && seconds && plural(seconds, "second"),
  ].filter(Boolean);

  return parts.slice(0, 2).join(" ");
}

/**
 * Text for people without the ids written into it for agents: `(thread_id: 01a…)` goes, `(schedule_id: 01a…,
 * delayed)` keeps `(delayed)`. Used on the platform's notes in messages ("[canopy] Message from …").
 */
export function withoutIds(text: string): string {
  const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

  return text
    .replace(new RegExp(` ?\\(\\w+_id: ${id}\\)`, "gi"), "")
    .replace(new RegExp(`\\(\\w+_id: ${id}, `, "gi"), "(");
}

/** Last segment of a path in either separator style. */
export const basename = (path: string): string => path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
