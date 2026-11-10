import { ItemStatus, type Item } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { describeTool } from "./tools/registry.ts";

/**
 * What a turn's work fold says about the work under it (docs/timeline-folding.md), the same on every client:
 * its counts ("3 commands, 1 edit"), each run of tools as one group ("Read 1 file and ran 5 commands") and, while
 * it runs, what it is doing now ("Running bun test…").
 */

/** Tools that group under one header; messages, reasoning and steers separate the groups. */
export const isToolItem = (item: Item): boolean =>
  !["agentMessage", "userMessage", "reasoning"].includes(item.content.case ?? "");

const KINDS: readonly (readonly [string, string, string])[] = [
  ["commandExecution", "command", "commands"],
  ["fileChange", "edit", "edits"],
  ["toolCall", "tool call", "tool calls"],
  ["agentBusCall", "agent call", "agent calls"],
  ["subagent", "subagent", "subagents"],
  ["webSearch", "search", "searches"],
  ["backgroundTask", "background task", "background tasks"],
  ["agentMessage", "message", "messages"],
  ["userMessage", "steered message", "steered messages"],
];

/** "3 commands, 1 edit": the most telling kinds of work, at most three. */
export function workCounts(items: readonly Item[]): string {
  const counts = new Map<string, number>();

  for (const item of items) {
    const kind = item.content.case ?? "";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return KINDS.filter(([kind]) => counts.has(kind))
    .slice(0, 3)
    .map(([kind, one, many]) => {
      const n = counts.get(kind) ?? 0;

      return `${n} ${n === 1 ? one : many}`;
    })
    .join(", ");
}

type Activity =
  | "read"
  | "command"
  | "edit"
  | "search"
  | "tool"
  | "agent call"
  | "subagent"
  | "background task"
  | "item";

/** Items other than tool calls, by their content case. */
const ITEM_ACTIVITIES = new Map<string, Activity>([
  ["commandExecution", "command"],
  ["fileChange", "edit"],
  ["webSearch", "search"],
  ["agentBusCall", "agent call"],
  ["subagent", "subagent"],
  ["backgroundTask", "background task"],
]);

function activity(item: Item): Activity {
  const content = item.content;

  if (content.case === "toolCall") {
    const body = describeTool({ ...content.value, running: true }).body;

    if (body === "read") return "read";

    if (body === "shell") return "command";

    if (body === "edit" || body === "patch") return "edit";

    if (body === "search" || body === "files" || body === "web-search") return "search";

    return "tool";
  }

  return ITEM_ACTIVITIES.get(content.case ?? "") ?? "item";
}

const VERBS = {
  read: ["Read", "file", "files"],
  command: ["Ran", "command", "commands"],
  edit: ["Made", "edit", "edits"],
  search: ["Ran", "search", "searches"],
  tool: ["Made", "tool call", "tool calls"],
  "agent call": ["Made", "agent call", "agent calls"],
  subagent: ["Started", "subagent", "subagents"],
  "background task": ["Started", "background task", "background tasks"],
  item: ["Updated", "item", "items"],
} satisfies Record<Activity, readonly [string, string, string]>;

const ACTIVITY_ICONS: Record<Activity, IconName> = {
  read: "document-text",
  command: "command-line",
  edit: "pencil-square",
  search: "magnifying-glass",
  tool: "wrench",
  "agent call": "user-group",
  subagent: "user-group",
  "background task": "command-line",
  item: "queue-list",
};

const STATUS_PRIORITY: readonly ItemStatus[] = [
  ItemStatus.FAILED,
  ItemStatus.DECLINED,
  ItemStatus.INTERRUPTED,
  ItemStatus.IN_PROGRESS,
  ItemStatus.COMPLETED,
];

export interface WorkGroupSummary {
  label: string;
  icon: IconName;
  status: ItemStatus;
  statusCount: number;
}

/** A run's label, kind icon and most important status, sharing one pass through tool descriptions. */
export function groupSummary(items: readonly Item[]): WorkGroupSummary {
  const counts = new Map<Activity, number>();
  let first: Activity = "item";
  let priority = STATUS_PRIORITY.length - 1;
  let statusCount = 0;

  for (const item of items) {
    const kind = activity(item);

    if (!counts.size) first = kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const rank = STATUS_PRIORITY.indexOf(item.status);

    if (rank >= 0 && rank <= priority) {
      statusCount = rank === priority ? statusCount + 1 : 1;
      priority = rank;
    }
  }

  const label = [...counts]
    .map(([kind, n], i) => {
      const [verb, one, many] = VERBS[kind];

      return `${i ? verb.toLowerCase() : verb} ${n} ${n === 1 ? one : many}`;
    })
    .join(" and ");

  return {
    label,
    icon: counts.size === 1 ? ACTIVITY_ICONS[first] : "queue-list",
    status: STATUS_PRIORITY[priority] ?? ItemStatus.COMPLETED,
    statusCount,
  };
}

/**
 * What a live fold is doing now. Only active work supplies a hint; finished calls never read as still running.
 * `running`: whether an item still runs (a command's background task can outlive it).
 */
export function currentWorkHint(
  items: readonly Item[],
  running: (item: Item) => boolean = (item) => item.status === ItemStatus.IN_PROGRESS,
): string {
  const active = items.filter(running);
  const reads = active.filter((item) => activity(item) === "read");
  const item = active.at(-1);

  if (!item) return "Thinking…";

  if (activity(item) === "read" && reads.length > 1) return `Reading ${reads.length} files…`;
  const content = item.content;

  if (content.case === "commandExecution") return `Running ${content.value.command.split("\n")[0]}…`;

  if (content.case === "toolCall") {
    const look = describeTool({ ...content.value, running: true });

    return `${look.title}${look.subject ? ` ${look.subject}` : ""}…`;
  }

  if (content.case === "fileChange") return `Editing ${content.value.changes.length} files…`;

  if (content.case === "backgroundTask") return content.value.description || "Running a background task…";

  if (content.case === "agentBusCall") return `Calling ${content.value.toolName}…`;

  if (content.case === "subagent") return content.value.description || "Waiting for a subagent…";

  // A message still streaming inside a collapsed fold: its text shows only once it is the answer.
  if (content.case === "agentMessage") return "Writing…";

  if (content.case === "interactionPrompt")
    return content.value.routedTo === "parent" ? "Waiting for the parent agent…" : "Waiting for your answer…";

  return "Thinking…";
}
