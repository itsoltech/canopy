import { Schema } from "effect";

/**
 * The thread's task list (docs/agent-bus.md, "Lista zadań"): the steps the agent plans for the current work and
 * how far it got. Every harness gets the same tool; the call is a transcript item, so the list is as durable as
 * the history. Clients pin the thread's latest list above the composer, together with the harnesses' own
 * checklists (Codex plan updates, ACP plans, Claude TodoWrite), whichever came last.
 */

export const UPDATE_TASKS_TOOL = "update_tasks";

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_LIST_MAX = 50;
export const TASK_TITLE_MAX = 200;

const Task = Schema.Struct({
  title: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(TASK_TITLE_MAX)).annotate({
    description: "What the step does, in a few words (e.g. 'Add the migration').",
  }),
  status: Schema.Literals(TASK_STATUSES),
});

export const UpdateTasks = Schema.Struct({
  tasks: Schema.Array(Task)
    .check(Schema.isMaxLength(TASK_LIST_MAX))
    .annotate({ description: "The whole list in order. It replaces the previous one; an empty list clears it." }),
});

export const TASK_TOOLS = {
  [UPDATE_TASKS_TOOL]: {
    name: UPDATE_TASKS_TOOL,
    description:
      "Keep a task list for multi-step work. The user sees it above the composer with each task's status. " +
      "Write it once the work is agreed and before you start, then call again as soon as a task starts or finishes. " +
      "Send the whole list every time. Keep one task in_progress at a time and mark each completed when it is done, " +
      "not in a batch at the end. Add, split or drop tasks when the plan changes. Skip it for a single quick step.",
    args: UpdateTasks,
    mutates: true,
  },
} as const;

export interface TaskProgress {
  readonly total: number;
  readonly completed: number;
}

export function taskProgress(tasks: readonly { readonly status: string }[]): TaskProgress {
  return { total: tasks.length, completed: tasks.filter((task) => task.status === "completed").length };
}
