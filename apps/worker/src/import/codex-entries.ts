import type { JsonObject, JsonValue } from "@canopy/domain";
import { isJsonObject, isString, jsonObject, jsonString } from "../providers/json.ts";

/**
 * Codex rollouts (`sessions/YYYY/MM/DD/rollout-*.jsonl`, docs/import.md): what a user typed and where a thread came
 * from. Newer CLIs write `event_msg item_completed` with whole items; older ones `event_msg user_message` and
 * `response_item` messages. Context Codex adds itself (environment, instructions) is not a prompt.
 */

const INJECTED =
  /^(?:<environment_context>|<user_instructions>|<skills_instructions>|<permissions|# AGENTS\.md|<turn_aborted>)/;

function texts(content: JsonValue | undefined): string {
  if (isString(content)) return content;

  if (!Array.isArray(content)) return "";

  return content.flatMap((part) => (isJsonObject(part) ? [jsonString(part["text"])] : [])).join("\n");
}

/** The user's prompt in a rollout line, or undefined. `seenItems`: the rollout has item_completed for prompts. */
export function codexPrompt(line: JsonObject, seenItems: boolean): string | undefined {
  const payload = jsonObject(line["payload"]);

  if (!payload) return undefined;

  if (line["type"] === "event_msg" && payload["type"] === "item_completed") {
    const item = jsonObject(payload["item"]);

    return item && /^usermessage$/i.test(jsonString(item["type"])) ? texts(item["content"]).trim() : undefined;
  }

  if (seenItems) return undefined;

  if (line["type"] === "event_msg" && payload["type"] === "user_message") {
    const text = jsonString(payload["message"]).trim();

    return text && !INJECTED.test(text) ? text : undefined;
  }

  return undefined;
}

/** cli | exec | ide | app | unknown, and whether the thread is a subagent (with its parent). */
export function codexOrigin(meta: JsonObject) {
  const source = meta["source"];
  const sub = jsonObject(jsonObject(source)?.["subagent"]);
  const spawn = jsonObject(sub?.["thread_spawn"]);
  const parent = jsonString(spawn?.["parent_thread_id"]);
  const originator = jsonString(meta["originator"]);
  const kind = isString(source) ? source : "";

  const origin =
    originator === "codex_cli_rs" || kind === "cli"
      ? "cli"
      : originator === "codex_exec" || kind === "exec"
        ? "exec"
        : originator === "codex_vscode"
          ? "ide"
          : originator
            ? "app"
            : "unknown";

  return { origin, subagent: sub !== undefined, parent };
}
