import { ItemStatus, type Item, type ui } from "@canopy/contracts";
import { UPDATE_TASKS_TOOL } from "./agent-bus/tasks.ts";
import { isJsonArray, objectsOf, parseObject, str, type JsonObject } from "./json.ts";
import { todos } from "./tools/registry.ts";

/**
 * A thread's task list as clients show it (docs/agent-bus.md, "Lista zadań"): the platform's update_tasks and
 * the harnesses' own checklists read as one list. The latest of them is the current one.
 */

export type TaskState = "pending" | "in_progress" | "completed";

export interface TaskListStep {
  readonly text: string;
  readonly status: TaskState;
}

export interface TaskList {
  readonly steps: readonly TaskListStep[];
  /** The harness's note on its plan (Codex explanation), "" without one. */
  readonly note: string;
}

const NATIVE_TODO_TOOLS = new Set(["TodoWrite", "update_plan", "todo_write"]);

/** Providers spell states differently (inProgress, in-progress, done); unknown ones read as pending. */
export function taskState(status: string): TaskState {
  const key = status.toLowerCase().replaceAll(/[\s_-]/g, "");

  if (key === "completed" || key === "complete" || key === "done") return "completed";

  return key === "inprogress" || key === "active" ? "in_progress" : "pending";
}

const list = (steps: readonly { text: string; status: string }[], note = ""): TaskList => ({
  steps: steps.flatMap((step) => (step.text.trim() ? [{ text: step.text, status: taskState(step.status) }] : [])),
  note,
});

function updateTasksSteps(args: JsonObject): { text: string; status: string }[] {
  return objectsOf(args["tasks"]).map((task) => ({ text: str(task["title"]), status: str(task["status"]) }));
}

/** An item that can set the task list, refused or failed ones included (they still end a running call). */
export function isTaskListItem(item: Item): boolean {
  const content = item.content;

  return (
    content.case === "todoList" ||
    content.case === "plan" ||
    (content.case === "agentBusCall" && content.value.toolName === UPDATE_TASKS_TOOL) ||
    (content.case === "toolCall" && NATIVE_TODO_TOOLS.has(content.value.name))
  );
}

/**
 * The task list an item sets, or undefined when it is no checklist. A plan without steps (a proposed plan
 * in plan mode) and a refused or failed call leave the current list as it was.
 */
export function taskListOf(item: Item): TaskList | undefined {
  const content = item.content;

  switch (content.case) {
    case "todoList":
      return list(content.value.items);
    case "plan":
      return content.value.steps.length > 0 ? list(content.value.steps, content.value.text) : undefined;
    case "agentBusCall": {
      if (content.value.toolName !== UPDATE_TASKS_TOOL || content.value.isError) return undefined;

      if (item.status === ItemStatus.FAILED || item.status === ItemStatus.DECLINED) return undefined;
      const args = parseObject(content.value.argumentsJson);

      return isJsonArray(args["tasks"]) ? list(updateTasksSteps(args)) : undefined;
    }

    case "toolCall": {
      if (!NATIVE_TODO_TOOLS.has(content.value.name) || content.value.isError) return undefined;
      const input = parseObject(content.value.inputJson);

      return list(todos(input), str(input["explanation"]));
    }

    default:
      return undefined;
  }
}

export interface CurrentTaskList extends TaskList {
  /** The item that set it, as a stable key for motion and a per-list dismissal. */
  readonly itemId: string;
  readonly turnId: string;
}

/** The thread's current list: the last checklist of its own top-level items, in timeline order. */
export function currentTaskList(
  entries: readonly { readonly item: Item; readonly turnId: string; readonly inherited: boolean }[],
): CurrentTaskList | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];

    if (!entry || entry.inherited || entry.item.parentItemId) continue;
    const tasks = taskListOf(entry.item);

    if (tasks)
      return tasks.steps.length > 0 ? { ...tasks, itemId: entry.item.itemId, turnId: entry.turnId } : undefined;
  }

  return undefined;
}

export interface TaskListSummary {
  readonly total: number;
  readonly completed: number;
  /** The step in progress, else the next pending one; undefined when all are done. */
  readonly current: TaskListStep | undefined;
  readonly done: boolean;
}

export function taskListSummary(tasks: TaskList): TaskListSummary {
  const completed = tasks.steps.filter((step) => step.status === "completed").length;

  const current =
    tasks.steps.find((step) => step.status === "in_progress") ?? tasks.steps.find((step) => step.status === "pending");

  return { total: tasks.steps.length, completed, current, done: completed === tasks.steps.length };
}

export interface TaskTurn {
  readonly id: string;
  readonly ordinal: number;
  /** queued | running | completed | interrupted | failed | cancelled */
  readonly status: string;
}

/** Queued and cancelled turns never touched the list. */
export const ranTurn = (status: string): boolean => status !== "queued" && status !== "cancelled";

/**
 * Whether a task list still describes current work, from the statuses of the turns that ran after its own.
 * A finished list stays until another turn starts; an unfinished one also while those turns are still running
 * (the agent may pick it up again), and leaves once one of them ends without touching it.
 */
export function taskListCurrent(tasks: TaskList, laterTurns: readonly string[]): boolean {
  const later = laterTurns.filter(ranTurn);

  return later.length === 0 || (!taskListSummary(tasks).done && later.every((status) => status === "running"));
}

/** The task list pinned above the composer, if it still describes current work (taskListCurrent). */
export function shownTaskList(
  entries: readonly { readonly item: Item; readonly turnId: string; readonly inherited: boolean }[],
  turns: readonly TaskTurn[],
): CurrentTaskList | undefined {
  const tasks = currentTaskList(entries);

  if (!tasks) return undefined;
  const turn = turns.find((entry) => entry.id === tasks.turnId);

  if (!turn) return undefined;
  const later = turns.flatMap((entry) => (entry.ordinal > turn.ordinal ? [entry.status] : []));

  return taskListCurrent(tasks, later) ? tasks : undefined;
}

/**
 * A thread's task list for lists (sidebar marks, hover card) from ui.Thread.tasks, only while work remains:
 * a finished list says nothing the thread's status does not.
 */
export function unfinishedThreadTasks(thread: ui.Thread): ui.ThreadTasks | undefined {
  return thread.tasks && thread.tasks.completed < thread.tasks.total ? thread.tasks : undefined;
}

/** "Tasks: 2 of 5 done · Wire the sidebar", a thread's task list in words (tooltip, screen readers). */
export function threadTasksLabel(tasks: ui.ThreadTasks): string {
  const progress = `Tasks: ${tasks.completed} of ${tasks.total} done`;

  return tasks.current ? `${progress} · ${tasks.current}` : progress;
}
