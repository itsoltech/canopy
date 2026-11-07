import type { JsonObject, JsonValue } from "@canopy/domain";
import { isJsonObject, isString, jsonString } from "../providers/json.ts";

/**
 * Claude Code session entries (`projects/<dir>/<session>.jsonl`, docs/import.md): what is a user's prompt, which
 * records are conversation and which are bookkeeping the import skips.
 */

/** Records that are not conversation: request caches, telemetry, queue bookkeeping (never imported). */
export const CLAUDE_SKIPPED: ReadonlySet<string> = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "atis-latch",
  "queue-operation",
  "cost-state",
  "file-history-snapshot",
  "last-prompt",
  "mode",
  "pr-link",
  "ai-title",
  "custom-title",
  "summary",
  "tag",
]);

const NOT_PROMPT =
  /^(?:<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|<command-message>|<task-notification>|\[Request interrupted by user)/;

/** Text of the blocks of a message content (a string or a list of blocks). */
export function contentText(content: JsonValue | undefined, kinds: ReadonlySet<string> = TEXT): string {
  if (isString(content)) return content;

  if (!Array.isArray(content)) return "";

  return content
    .flatMap((block) =>
      isJsonObject(block) && kinds.has(jsonString(block["type"])) ? [jsonString(block["text"])] : [],
    )
    .join("\n");
}

const TEXT: ReadonlySet<string> = new Set(["text"]);

function hasBlock(content: JsonValue | undefined, type: string): boolean {
  return Array.isArray(content) && content.some((b) => isJsonObject(b) && b["type"] === type);
}

/** The prompt a user typed (or a slash command), or undefined for tool results, meta and summaries. */
export function promptText(entry: JsonObject): string | undefined {
  if (entry["type"] !== "user" || entry["isMeta"] === true || entry["isCompactSummary"] === true) return undefined;

  if (entry["isVisibleInTranscriptOnly"] === true) return undefined;
  const message = entry["message"];

  if (!isJsonObject(message)) return undefined;
  const content = message["content"];

  if (hasBlock(content, "tool_result")) return undefined;
  const text = contentText(content).trim();

  if (!text && !hasBlock(content, "image")) return undefined;

  if (NOT_PROMPT.test(text)) return undefined;
  // A slash command: "/name args" as typed.
  const command = /^<command-name>\s*(\S+)\s*<\/command-name>/.exec(text);

  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();

    return [command[1], args].filter(Boolean).join(" ");
  }

  return hasBlock(content, "image") ? `${text}\n[image]`.trim() : text;
}

/** cli | exec | sdk | ide | unknown, from the session's entrypoint. */
export function claudeOrigin(entrypoint: string): string {
  if (entrypoint === "cli") return "cli";

  if (entrypoint === "sdk-cli") return "exec";

  if (entrypoint.startsWith("sdk")) return "sdk";

  if (/vscode|jetbrains|ide/i.test(entrypoint)) return "ide";

  return entrypoint ? "app" : "unknown";
}

/** A title the session recorded: user's own name first, then the generated one, then an old summary. */
export function claudeTitle(entry: JsonObject): { title: string; user: boolean } | undefined {
  if (entry["type"] === "custom-title" && isString(entry["customTitle"]))
    return { title: entry["customTitle"], user: true };

  if (entry["type"] === "ai-title" && isString(entry["aiTitle"])) return { title: entry["aiTitle"], user: false };

  if (entry["type"] === "summary" && isString(entry["summary"])) return { title: entry["summary"], user: false };

  return undefined;
}
