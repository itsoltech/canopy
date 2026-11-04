import { formatDateTime } from "#lib/shared/format.ts";
import {
  listOf,
  num,
  objectOf,
  objectsOf,
  parseObject,
  str,
  isJsonObject,
  isNumber,
  type JsonObject,
  type JsonValue,
} from "#lib/shared/json.ts";
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

const LOOKS = new Map<string, Look>(
  Object.entries({
    request_secret: {
      doing: "Asking for a secret",
      done: "Asked for a secret",
      tried: "ask for a secret",
      icon: "lock-closed",
    },
    spawn_thread: {
      doing: "Starting a subagent",
      done: "Started a subagent",
      tried: "start a subagent",
      icon: "sparkles",
    },
    send_message: {
      doing: "Sending a message to",
      done: "Sent a message to",
      tried: "send a message to",
      icon: "paper-airplane",
    },
    wait_threads: { doing: "Waiting for", done: "Waited for", tried: "wait for", icon: "clock" },
    get_thread: { doing: "Checking", done: "Checked", tried: "check", icon: "signal" },
    read_thread: { doing: "Reading", done: "Read", tried: "read", icon: "document-text" },
    list_threads: { doing: "Listing subagents", done: "Listed subagents", tried: "list subagents", icon: "queue-list" },
    interrupt_thread: { doing: "Interrupting", done: "Interrupted", tried: "interrupt", icon: "stop" },
    close_thread: { doing: "Closing", done: "Closed", tried: "close", icon: "archive-box" },
    list_interactions: {
      doing: "Checking pending questions",
      done: "Checked pending questions",
      tried: "check pending questions",
      icon: "question-mark-circle",
    },
    answer_interaction: {
      doing: "Answering for a side thread",
      done: "Answered for a side thread",
      tried: "answer for a side thread",
      icon: "hand-raised",
    },
    list_agents: { doing: "Listing agents", done: "Listed agents", tried: "list agents", icon: "user-group" },
    schedule_wakeup: {
      doing: "Scheduling a wake-up",
      done: "Scheduled a wake-up",
      tried: "schedule a wake-up",
      icon: "clock",
    },
    schedule_recurring: {
      doing: "Scheduling a recurring run",
      done: "Scheduled a recurring run",
      tried: "schedule a recurring run",
      icon: "arrow-path-rounded-square",
    },
    list_schedules: {
      doing: "Listing schedules",
      done: "Listed schedules",
      tried: "list schedules",
      icon: "calendar-days",
    },
    cancel_schedule: {
      doing: "Cancelling a schedule",
      done: "Cancelled a schedule",
      tried: "cancel a schedule",
      icon: "calendar-days",
    },
  } satisfies Record<string, Look>),
);

/** A tool of the agent bus (its calls also arrive as their own agent bus items, also from Codex scripts). */
export const isBusTool = (name: string): boolean => LOOKS.has(name);

const ANSWERS = new Map([
  ["allow", "Allowed"],
  ["deny", "Denied"],
  ["answer", "Answered"],
  ["cancel", "Dismissed"],
]);

export interface BusLook {
  readonly title: string;
  readonly icon: IconName;
}

/** Title and icon of a bus call; a tool this UI does not know shows its name in words. */
export function busLook(tool: string, args: JsonObject, running: boolean, refused = false): BusLook {
  const look = LOOKS.get(tool);

  if (!look) return { title: humanizeToolName(tool), icon: "sparkles" };

  if (refused) return { title: `Tried to ${look.tried}`, icon: look.icon };

  if (tool === "list_threads" && str(args["scope"]) === "tree")
    return { title: running ? "Listing the thread tree" : "Listed the thread tree", icon: look.icon };

  if (tool === "answer_interaction" && !running) {
    const answer = ANSWERS.get(str(args["response"]));

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

/** One thread of get_thread / wait_threads / list_threads (gateway ThreadSummary). */
export function threadSummary(record: JsonObject): ThreadSummary | undefined {
  const threadId = str(record["thread_id"]);

  if (!threadId) return undefined;

  const turn = objectOf(record["last_turn"]);
  const turnStatus = str(turn["status"]);
  const reason = str(turn["reason"]);

  return {
    threadId,
    title: str(record["title"]),
    status: str(record["status"]),
    settled: record["settled"] === true,
    queuedTurns: num(record["queued_turns"]),
    waitingForParent: num(record["waiting_for_parent"]),
    waitingForUser: num(record["waiting_for_user"]),
    lastTurn: turnStatus ? `${humanizeEnum(turnStatus)}${reason ? `: ${reason}` : ""}` : "",
    lastTurnStatus: turnStatus,
    lastMessage: str(record["last_message"]).trim(),
    settings: [str(record["model"]), str(record["effort"]), permissionWords(str(record["permission_mode"]))]
      .filter(Boolean)
      .join(" · "),
  };
}

/** Bus permission modes in the words the rest of the UI uses (labels.ts). */
export function permissionWords(mode: string): string {
  const key = mode.toLowerCase().replace(/^permission_mode_/, "");

  return (
    { read_only: "Read only", ask: "Ask first", accept_edits: "Accept edits", full_auto: "Full auto" }[key] ??
    humanizeEnum(mode)
  );
}

/** The threads a get_thread, wait_threads or list_threads result describes. */
export function summariesOf(tool: string, result: JsonObject): ThreadSummary[] {
  const list = tool === "get_thread" ? [result] : objectsOf(result["threads"]);

  return list.flatMap((value) => threadSummary(value) ?? []);
}

export interface TranscriptLine {
  readonly key: string;
  readonly role: "user" | "agent" | "activity";
  readonly text: string;
  /** Activity in code (a command). */
  readonly mono: boolean;
}

/** read_thread `entries` as a short transcript: messages as bubbles, every other item as one line of activity. */
export function transcriptOf(result: JsonObject): TranscriptLine[] {
  return listOf(result["entries"]).flatMap((value, index): TranscriptLine[] => {
    if (!isJsonObject(value)) return [];
    const entry = value;
    const seq = entry["seq"];
    const key = `${isNumber(seq) ? seq : index}`;
    const type = str(entry["type"]);
    const body = (name: string) => objectOf(entry[name]);

    switch (type) {
      case "user_message":
        return [{ key, role: "user", text: str(body("userMessage")["text"]), mono: false }];
      case "agent_message":
        return [{ key, role: "agent", text: str(body("agentMessage")["text"]), mono: false }];
      case "reasoning":
        return [{ key, role: "activity", text: "Thought it through", mono: false }];
      case "command_execution":
        return [
          { key, role: "activity", text: str(body("commandExecution")["command"]) || "Ran a command", mono: true },
        ];
      case "file_change": {
        const names = listOf(body("fileChange")["changes"]).flatMap((c) => {
          const name = str(objectOf(c)["path"]).split("/").pop();

          return name ? [name] : [];
        });

        return [
          {
            key,
            role: "activity",
            text: names.length > 0 ? `Edited ${names.join(", ")}` : "Edited files",
            mono: false,
          },
        ];
      }

      case "tool_call": {
        const call = body("toolCall");

        const look = describeTool({
          server: str(call["server"]),
          name: str(call["name"]),
          inputJson: str(call["inputJson"]),
          output: "",
          isError: false,
          running: false,
        });

        return [
          { key, role: "activity", text: look.subject ? `${look.title} ${look.subject}` : look.title, mono: false },
        ];
      }

      case "agent_bus_call": {
        const call = body("agentBusCall");

        return [
          {
            key,
            role: "activity",
            text: busLook(str(call["toolName"]), parseObject(str(call["argumentsJson"])), false).title,
            mono: false,
          },
        ];
      }

      case "web_search":
        return [
          {
            key,
            role: "activity",
            text: `Searched the web for ${str(body("webSearch")["query"])}`.trim(),
            mono: false,
          },
        ];
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
export function scheduleOf(args: JsonObject, result: JsonObject = {}): ScheduleView {
  const cron = str(args["cron"]) || str(result["cron"]);
  const timezone = str(args["timezone"]) || str(result["timezone"]);
  const at = str(args["at"]) || str(args["run_at"]);
  const delay = num(args["delay_seconds"]);

  const when = cron
    ? `${describeCron(cron)}${timezone && timezone !== "UTC" ? ` (${timezone})` : ""}`
    : at
      ? `Once, ${dateWords(at)}`
      : delay
        ? `In ${humanizeSeconds(delay)}`
        : "Once";

  const until = str(args["until"]);
  const maxRuns = num(args["max_runs"]);
  const next = str(result["next_run_at"]) || str(args["next_run_at"]);

  return {
    when,
    next: next ? dateWords(next) : "",
    prompt: str(args["prompt"]),
    threadId: str(args["thread_id"]) || str(result["thread_id"]),
    limits: [until && `until ${dateWords(until)}`, maxRuns && `up to ${plural(maxRuns, "run")}`]
      .filter(Boolean)
      .join(", "),
    status: str(args["status"]),
  };
}

/** list_schedules rows. */
export function schedulesOf(result: JsonObject): ScheduleView[] {
  return objectsOf(result["schedules"]).map((row) => scheduleOf(row));
}

export interface InteractionView {
  readonly threadId: string;
  readonly kind: string;
  /** The tool it is about, in words ("Bash", "Web fetch"). */
  readonly tool: string;
  readonly request: JsonValue | undefined;
}

/** list_interactions: what the side threads ask. */
export function interactionsOf(result: JsonObject): InteractionView[] {
  return objectsOf(result["interactions"]).map((record) => ({
    threadId: str(record["thread_id"]),
    kind: humanizeEnum(str(record["kind"])) || "Question",
    tool: humanizeToolName(str(record["tool_name"])),
    request: record["request"],
  }));
}

/** How a send_message was delivered, in words. */
export function deliveryOf(args: JsonObject, result: JsonObject): string {
  const asked = str(args["delivery"]) || "queue";
  const done = str(result["delivery"]) || asked;

  if (asked === "steer" && done === "queue") return "Nothing was running there, so it runs as the next turn";

  return done === "steer" ? "Joins the turn that is running now" : "Runs as the next turn";
}

/**
 * list_agents rows: the provider instances a subagent can run on ({provider: "claude/native", name, models: [{id, name,
 * efforts, default}], note}); `settings` is the instance key, `description` its models (the default first named so).
 */
export interface AgentRow {
  readonly name: string;
  readonly description: string;
  readonly settings: string;
}

export function agentsOf(result: JsonObject): AgentRow[] {
  return objectsOf(result["agents"]).flatMap((record) => {
    const name = str(record["name"]) || str(record["provider"]);

    const models = objectsOf(record["models"]).flatMap((model) => {
      const label = str(model["name"]) || str(model["id"]);

      return label ? [model["default"] === true ? `${label} (default)` : label] : [];
    });

    const shown = models.length > 6 ? [...models.slice(0, 6), `${models.length - 6} more`] : models;

    return name
      ? [{ name, description: shown.join(", ") || str(record["note"]), settings: str(record["provider"]) }]
      : [];
  });
}
