import { Schema } from "effect";

/**
 * Agent bus tools for the thread's own background work (docs/agent-bus.md, "Zadania w tle"; docs/execution.md):
 * processes and shells that outlive the turn that started them (Codex unified exec, Claude background Bash).
 * The gateway answers them from the timeline, so they see tasks of earlier worker processes too (stopped by a
 * restart, lost in a crash). Every thread has them, side threads included. Kept apart from tools.ts, which
 * merges them into AGENT_BUS_TOOLS.
 */

const TaskId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
  description: "task_id from list_background_tasks or from a background task note (also the process id Codex shows).",
});

const OtherThread = Schema.optionalKey(
  Schema.String.check(Schema.isUUID()).annotate({
    description: "Another thread to look at (one of your tree, or one the user mentioned). Default: this thread.",
  }),
);

export const ListBackgroundTasks = Schema.Struct({
  status: Schema.optionalKey(
    Schema.Literals(["all", "running", "finished"]).annotate({
      description: "all (default), running, or finished (completed, failed, interrupted).",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description: "Newest first; default 20.",
    }),
  ),
  thread_id: OtherThread,
});

export const GetBackgroundTask = Schema.Struct({
  task_id: TaskId,
  output_lines: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })).annotate({
      description: "How many of the last output lines to return (default 80).",
    }),
  ),
  thread_id: OtherThread,
});

export const StopBackgroundTask = Schema.Struct({
  task_id: TaskId,
  thread_id: Schema.optionalKey(
    Schema.String.check(Schema.isUUID()).annotate({
      description: "A thread you spawned whose task to stop. Default: this thread.",
    }),
  ),
});

export const BACKGROUND_TASK_TOOLS = {
  list_background_tasks: {
    name: "list_background_tasks",
    description:
      "List this thread's background tasks (processes and shells that keep running after the turn that started them) with their status: " +
      "running, completed, failed or interrupted, why they ended in plain words (e.g. stopped by the user, stopped because the worker " +
      "was restarted for a deploy, lost in a crash, exit code N), start and end times, duration and the turn that started them. " +
      "Use it to check on background work, e.g. when asked what happened to a task.",
    args: ListBackgroundTasks,
    mutates: false,
  },
  get_background_task: {
    name: "get_background_task",
    description:
      "Status of one background task: how and why it ended (or that it still runs), exit code, times, duration, its command and the tail " +
      "of its output. This is how to check on a background task; its output stays readable after it ended or was stopped.",
    args: GetBackgroundTask,
    mutates: false,
  },
  stop_background_task: {
    name: "stop_background_task",
    description:
      "Stop a running background task of this thread (the same as the user's Stop). It ends as stopped; check with get_background_task.",
    args: StopBackgroundTask,
    mutates: true,
  },
} as const;

export type BackgroundTaskToolName = keyof typeof BACKGROUND_TASK_TOOLS;

export function isBackgroundTaskTool(name: string): name is BackgroundTaskToolName {
  return Object.hasOwn(BACKGROUND_TASK_TOOLS, name);
}
