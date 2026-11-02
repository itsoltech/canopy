import { formatDateTime, parseObject, str } from "#lib/shared/format.ts";
import { humanizeEnum, humanizeSeconds, humanizeToolName, plural } from "#lib/shared/humanize.ts";
import type { IconName } from "#lib/shared/ui/icons.ts";
import { describeCron } from "#lib/features/schedules/schedules.ts";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describeTool } from "./registry.ts";

/**
 * Agent bus calls (docs/agent-bus.md) as people read them: a title per tool, and the arguments and
 * results (packages/domain agent-bus tools, apps/gateway core/agent-bus.ts) turned into thread summaries,
 * a short transcript, schedules in words and interactions — without ids, seqs or enum keys.
 */

interface Look {
  readonly doing: string;
  readonly done: string;
  /** What it tried, for a refused call ("Tried to close"). */
  readonly tried: string;
  readonly icon: IconName;
}

const LOOKS: Record<string, Look> = {
  request_secret: { doing: "Asking for a secret", done: "Asked for a secret", tried: "ask for a secret", icon: "lock-closed" },
  spawn_thread: { doing: "Starting a subagent", done: "Started a subagent", tried: "start a subagent", icon: "sparkles" },
  send_message: { doing: "Sending a message to", done: "Sent a message to", tried: "send a message to", icon: "paper-airplane" },
  wait_threads: { doing: "Waiting for", done: "Waited for", tried: "wait for", icon: "clock" },
  get_thread: { doing: "Checking", done: "Checked", tried: "check", icon: "signal" },
  read_thread: { doing: "Reading", done: "Read", tried: "read", icon: "document-text" },
  list_threads: { doing: "Listing subagents", done: "Listed subagents", tried: "list subagents", icon: "queue-list" },
  interrupt_thread: { doing: "Interrupting", done: "Interrupted", tried: "interrupt", icon: "stop" },
  close_thread: { doing: "Closing", done: "Closed", tried: "close", icon: "archive-box" },
  list_interactions: { doing: "Checking pending questions", done: "Checked pending questions", tried: "check pending questions", icon: "question-mark-circle" },
  answer_interaction: { doing: "Answering for a side thread", done: "Answered for a side thread", tried: "answer for a side thread", icon: "hand-raised" },
  list_agents: { doing: "Listing agents", done: "Listed agents", tried: "list agents", icon: "user-group" },
  schedule_wakeup: { doing: "Scheduling a wake-up", done: "Scheduled a wake-up", tried: "schedule a wake-up", icon: "clock" },
  schedule_recurring: { doing: "Scheduling a recurring run", done: "Scheduled a recurring run", tried: "schedule a recurring run", icon: "arrow-path-rounded-square" },
  list_schedules: { doing: "Listing schedules", done: "Listed schedules", tried: "list schedules", icon: "calendar-days" },
  cancel_schedule: { doing: "Cancelling a schedule", done: "Cancelled a schedule", tried: "cancel a schedule", icon: "calendar-days" },
};

/** A tool of the agent bus (its calls also arrive as their own agent bus items, also from Codex scripts). */
export const isBusTool = (name: string): boolean => Object.hasOwn(LOOKS, name);

const ANSWERS: Record<string, string> = { allow: "Allowed", deny: "Denied", answer: "Answered", cancel: "Dismissed" };

/** Title and icon of a bus call; a tool this UI does not know shows its name in words. */
export function busLook(tool: string, args: Record<string, unknown>, running: boolean, refused = false): { title: string; icon: IconName } {
  const look = LOOKS[tool];
  if (!look) return { title: humanizeToolName(tool), icon: "sparkles" };
  if (refused) return { title: `Tried to ${look.tried}`, icon: look.icon };
  if (tool === "list_threads" && str(args["scope"]) === "tree") return { title: running ? "Listing the thread tree" : "Listed the thread tree", icon: look.icon };
  if (tool === "answer_interaction" && !running) {
    const answer = ANSWERS[str(args["response"])];
    if (answer) return { title: `${answer} for a side thread`, icon: look.icon };
  }
  return { title: running ? look.doing : look.done, icon: look.icon };
}

/** The reason a refused call gives (`{"error": "…"}` or its text), without the tool's name in front. */
export function busError(resultJson: string, tool = ""): string {
  const record = parseObject(resultJson);
  const reason = str(record["error"]) || resultJson.trim();
  return tool && reason.startsWith(`${tool}: `) ? reason.slice(tool.length + 2) : reason;
}

export interface ThreadSummary {
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  /** Nothing running or queued. */
  readonly settled: boolean;
  readonly queuedTurns: number;
  readonly waitingForParent: number;
  readonly waitingForUser: number;
  /** How its last turn ended ("Completed", "Failed: reason"), "" before the first one ends. */
  readonly lastTurn: string;
  readonly lastTurnStatus: string;
  readonly lastMessage: string;
  /** What it runs with, in words ("gpt-5 · high · Full auto"). */
  readonly settings: string;
}

const count = (value: unknown) => (typeof value === "number" ? value : 0);

/** One thread of get_thread / wait_threads / list_threads (gateway ThreadSummary). */
export function threadSummary(value: unknown): ThreadSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const threadId = str(record["thread_id"]);
  if (!threadId) return undefined;
  const turn = record["last_turn"] && typeof record["last_turn"] === "object" ? (record["last_turn"] as Record<string, unknown>) : undefined;
  const turnStatus = str(turn?.["status"]);
  const reason = str(turn?.["reason"]);
  return {
    threadId,
    title: str(record["title"]),
    status: str(record["status"]),
    settled: record["settled"] === true,
    queuedTurns: count(record["queued_turns"]),
    waitingForParent: count(record["waiting_for_parent"]),
    waitingForUser: count(record["waiting_for_user"]),
    lastTurn: turnStatus ? `${humanizeEnum(turnStatus)}${reason ? `: ${reason}` : ""}` : "",
    lastTurnStatus: turnStatus,
    lastMessage: str(record["last_message"]).trim(),
    settings: [str(record["model"]), str(record["effort"]), permissionWords(str(record["permission_mode"]))].filter(Boolean).join(" · "),
  };
}

/** Bus permission modes in the words the rest of the UI uses (labels.ts). */
export function permissionWords(mode: string): string {
  const key = mode.toLowerCase().replace(/^permission_mode_/, "");
  return { read_only: "Read only", ask: "Ask first", accept_edits: "Accept edits", full_auto: "Full auto" }[key] ?? humanizeEnum(mode);
}

/** The threads a get_thread, wait_threads or list_threads result describes. */
export function summariesOf(tool: string, result: Record<string, unknown>): ThreadSummary[] {
  const list = tool === "get_thread" ? [result] : Array.isArray(result["threads"]) ? result["threads"] : [];
  return list.flatMap((value: unknown) => threadSummary(value) ?? []);
}

export interface TranscriptLine {
  readonly key: string;
  readonly role: "user" | "agent" | "activity";
  readonly text: string;
  /** Activity in code (a command). */
  readonly mono: boolean;
}

/** read_thread `entries` as a short transcript: messages as bubbles, every other item as one line of activity. */
export function transcriptOf(result: Record<string, unknown>): TranscriptLine[] {
  const entries = Array.isArray(result["entries"]) ? result["entries"] : [];
  return entries.flatMap((value: unknown, index: number): TranscriptLine[] => {
    if (!value || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    const key = `${typeof entry["seq"] === "number" ? entry["seq"] : index}`;
    const type = str(entry["type"]);
    const body = (name: string) => (entry[name] && typeof entry[name] === "object" ? (entry[name] as Record<string, unknown>) : {});
    switch (type) {
      case "user_message":
        return [{ key, role: "user", text: str(body("userMessage")["text"]), mono: false }];
      case "agent_message":
        return [{ key, role: "agent", text: str(body("agentMessage")["text"]), mono: false }];
      case "reasoning":
        return [{ key, role: "activity", text: "Thought it through", mono: false }];
      case "command_execution":
        return [{ key, role: "activity", text: str(body("commandExecution")["command"]) || "Ran a command", mono: true }];
      case "file_change": {
        const changes = Array.isArray(body("fileChange")["changes"]) ? (body("fileChange")["changes"] as Record<string, unknown>[]) : [];
        const names = changes.map((c) => str(c?.["path"]).split("/").pop()).filter(Boolean);
        return [{ key, role: "activity", text: names.length > 0 ? `Edited ${names.join(", ")}` : "Edited files", mono: false }];
      }
      case "tool_call": {
        const call = body("toolCall");
        const look = describeTool({ server: str(call["server"]), name: str(call["name"]), inputJson: str(call["inputJson"]), output: "", isError: false, running: false });
        return [{ key, role: "activity", text: look.subject ? `${look.title} ${look.subject}` : look.title, mono: false }];
      }
      case "agent_bus_call": {
        const call = body("agentBusCall");
        return [{ key, role: "activity", text: busLook(str(call["toolName"]), parseObject(str(call["argumentsJson"])), false).title, mono: false }];
      }
      case "web_search":
        return [{ key, role: "activity", text: `Searched the web for ${str(body("webSearch")["query"])}`.trim(), mono: false }];
      default:
        return type ? [{ key, role: "activity", text: humanizeEnum(type), mono: false }] : [];
    }
  });
}

export interface ScheduleView {
  /** When it runs, in words ("In 1 minute", "Weekdays at 09:00 (Europe/Warsaw)"). */
  readonly when: string;
  /** The next run, formatted; "" when unknown. */
  readonly next: string;
  readonly prompt: string;
  readonly threadId: string;
  /** Limits ("until Nov 3, 2026", "up to 5 runs"), "" without. */
  readonly limits: string;
  readonly status: string;
}

const dateWords = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatDateTime(timestampFromDate(date));
};

/** A schedule from schedule_wakeup / schedule_recurring (arguments and result) or a list_schedules row. */
export function scheduleOf(args: Record<string, unknown>, result: Record<string, unknown> = {}): ScheduleView {
  const cron = str(args["cron"]) || str(result["cron"]);
  const timezone = str(args["timezone"]) || str(result["timezone"]);
  const at = str(args["at"]) || str(args["run_at"]);
  const delay = typeof args["delay_seconds"] === "number" ? args["delay_seconds"] : 0;
  const when = cron
    ? `${describeCron(cron)}${timezone && timezone !== "UTC" ? ` (${timezone})` : ""}`
    : at
      ? `Once, ${dateWords(at)}`
      : delay
        ? `In ${humanizeSeconds(delay)}`
        : "Once";
  const until = str(args["until"]);
  const maxRuns = typeof args["max_runs"] === "number" ? args["max_runs"] : 0;
  const next = str(result["next_run_at"]) || str(args["next_run_at"]);
  return {
    when,
    next: next ? dateWords(next) : "",
    prompt: str(args["prompt"]),
    threadId: str(args["thread_id"]) || str(result["thread_id"]),
    limits: [until && `until ${dateWords(until)}`, maxRuns && `up to ${plural(maxRuns, "run")}`].filter(Boolean).join(", "),
    status: str(args["status"]),
  };
}

/** list_schedules rows. */
export function schedulesOf(result: Record<string, unknown>): ScheduleView[] {
  const rows = Array.isArray(result["schedules"]) ? result["schedules"] : [];
  return rows.flatMap((row: unknown) => (row && typeof row === "object" ? [scheduleOf(row as Record<string, unknown>)] : []));
}

export interface InteractionView {
  readonly threadId: string;
  readonly kind: string;
  /** The tool it is about, in words ("Bash", "Web fetch"). */
  readonly tool: string;
  readonly request: unknown;
}

/** list_interactions: what the side threads ask. */
export function interactionsOf(result: Record<string, unknown>): InteractionView[] {
  const rows = Array.isArray(result["interactions"]) ? result["interactions"] : [];
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    return [{ threadId: str(record["thread_id"]), kind: humanizeEnum(str(record["kind"])) || "Question", tool: humanizeToolName(str(record["tool_name"])), request: record["request"] }];
  });
}

/** How a send_message was delivered, in words. */
export function deliveryOf(args: Record<string, unknown>, result: Record<string, unknown>): string {
  const asked = str(args["delivery"]) || "queue";
  const done = str(result["delivery"]) || asked;
  if (asked === "steer" && done === "queue") return "Nothing was running there, so it runs as the next turn";
  return done === "steer" ? "Joins the turn that is running now" : "Runs as the next turn";
}

/**
 * list_agents rows: the provider instances a subagent can run on ({provider: "claude/native", name, models: [{id, name,
 * efforts, default}], note}); `settings` is the instance key, `description` its models (the default first named so).
 */
export function agentsOf(result: Record<string, unknown>): { name: string; description: string; settings: string }[] {
  const rows = Array.isArray(result["agents"]) ? result["agents"] : [];
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const name = str(record["name"]) || str(record["provider"]);
    const models = (Array.isArray(record["models"]) ? record["models"] : []).flatMap((m: unknown) => {
      if (!m || typeof m !== "object") return [];
      const model = m as Record<string, unknown>;
      const label = str(model["name"]) || str(model["id"]);
      return label ? [model["default"] === true ? `${label} (default)` : label] : [];
    });
    const shown = models.length > 6 ? [...models.slice(0, 6), `${models.length - 6} more`] : models;
    return name ? [{ name, description: shown.join(", ") || str(record["note"]), settings: str(record["provider"]) }] : [];
  });
}
