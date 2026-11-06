import { create } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { Predicate } from "effect";
import { isJsonObject } from "./json.ts";
import type { ToolSpec } from "./types.ts";

/** Explicit owner decisions only. These tools cannot be covered by a standing rule or full auto. */
export const ALWAYS_ASK_TOOLS = new Set([
  "create_bot",
  "archive_project",
  "add_workspace",
  "update_workspace",
  "remove_workspace",
  "set_project_defaults",
  "set_instance_worker",
  "set_instance_models",
  "set_thread_model",
  "archive_thread",
  "delete_thread",
  "fork_thread",
  "set_thread_permission",
  "answer_interaction",
  "stop_background_task",
  "cancel_schedule",
]);

const elevated = (value: JsonValue | undefined) => value !== undefined && value !== "ask" && value !== "read_only";

export function alwaysAsk(tool: ToolSpec, args: JsonObject): boolean {
  if (tool.source !== "platform") return false;

  if (ALWAYS_ASK_TOOLS.has(tool.name) || tool.name === "ask_user") return true;

  if (tool.name === "update_self")
    return ["model", "effort", "provider", "provider_instance", "approval_policy", "thread_permission", "rules"].some(
      (key) => Object.hasOwn(args, key),
    );

  if (tool.name === "start_thread") return elevated(args["permission"]);

  if (tool.name === "update_settings") return args["thread_defaults"] !== undefined;
  const thread = args["new_thread"];

  return (
    ["create_schedule", "update_schedule"].includes(tool.name) && isJsonObject(thread) && elevated(thread["permission"])
  );
}

/** The entire allowlist. No arbitrary model tool name becomes a grant. */
const ACTION_LABELS = {
  create_project: "creating projects",
  rename_project: "renaming projects",
  send_message: "messaging threads",
  rename_thread: "renaming threads",
  interrupt_thread: "interrupting threads",
  set_goal: "updating thread goals",
  regenerate_title: "generating thread titles",
  create_schedule: "creating schedules with Ask first or Read only permissions",
  update_schedule: "updating schedules with Ask first or Read only permissions",
  set_schedule_status: "pausing and resuming schedules",
  schedule_wakeup: "scheduling reminders",
  update_settings: "updating text generation settings",
  update_self: "updating the bot’s name, appearance and instructions",
};

/** Choices are built from trusted tool metadata and exact identifiers, never names found in a prompt. */
export function ruleOptions(tool: ToolSpec, args: JsonObject, phrase: string): bots.BotApprovalRule[] {
  if (alwaysAsk(tool, args)) return [];

  const choice = (kind: string, label: string, targetId = "", toolName = "") =>
    create(bots.BotApprovalRuleSchema, { id: Bun.randomUUIDv7(), kind, targetId, toolName, label });

  const text = (key: string) => (Predicate.isString(args[key]) ? args[key] : "");

  if (tool.source === "mcp" && tool.serverId && tool.remoteName) {
    const account = tool.serverName || "this connected account";

    return [
      choice("connector", account, tool.serverId),
      choice("connector", `${account} · ${tool.remoteName}`, tool.serverId, tool.remoteName),
    ];
  }

  if (tool.source !== "platform") return [];

  if (tool.name === "start_thread" && text("project_id"))
    return [
      choice("start_thread", phrase.replace(/^Starting a thread/, "starting threads"), text("project_id")),
      choice("start_thread", "starting threads in any project"),
    ];

  if (tool.name === "send_bot_message" && text("bot_id"))
    return [choice("send_bot_message", phrase.replace(/^Messaging/, "messaging"), text("bot_id"))];
  const label = Object.entries(ACTION_LABELS).find(([name]) => name === tool.name)?.[1];

  return label ? [choice(tool.name, label)] : [];
}

export const matchesRule = (rule: bots.BotApprovalRule, option: bots.BotApprovalRule) =>
  rule.kind === option.kind && rule.targetId === option.targetId && rule.toolName === option.toolName;
