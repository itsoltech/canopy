/**
 * Background tasks in words (docs/execution.md, "Zadania w tle"): how a task ended and why, for the platform note
 * that tells the agent (a follow-up turn or a steer), for the agent's tools (list_background_tasks,
 * get_background_task) and for the UI. One place, so the agent and the user read the same reason.
 *
 * Stop reasons (BackgroundTask.stop_reason) come from the worker: stopped_by_user, stopped (the harness),
 * error, drain, limit, worker_shutdown (graceful stop: restart, deploy), worker_lost (the worker died without
 * recording a stop: crash, kill -9), worker_restart (the provider runtime started again: settings, its process exited).
 */

/** How a task stands, as the agent's tools report it. */
export type BackgroundOutcome = "running" | "completed" | "failed" | "interrupted";

/** Item statuses as stored (thread_items.status) or as ItemStatus names. */
export function backgroundOutcome(status: string): BackgroundOutcome {
  switch (status.toLowerCase().replace(/^item_status_/, "")) {
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "interrupted";
  }
}

const REASONS: Readonly<Record<string, string>> = {
  stopped_by_user: "stopped by the user",
  stopped: "stopped by the harness",
  drain: "stopped because the worker was draining before it shut down",
  limit: "stopped because it reached a resource limit",
  worker_shutdown: "stopped because the worker was shut down for a restart or deploy; the process was killed",
  worker_lost: "lost: the worker process ended unexpectedly (crash or kill) while the task ran, and the task died with it",
  worker_restart: "stopped because the provider runtime was restarted (a settings change, or its process exited)",
};

/** Why a task ended, in plain words for the agent ("completed with exit code 0", "stopped by the user", ...). */
export function backgroundEndReason(outcome: BackgroundOutcome, stopReason: string, exitCode?: number): string {
  const exit = exitCode === undefined ? "" : ` with exit code ${exitCode}`;
  if (outcome === "running") return "still running";
  if (outcome === "completed") return `completed${exit}`;
  if (outcome === "failed") return stopReason && stopReason !== "error" && REASONS[stopReason] ? REASONS[stopReason] : `failed${exit}`;
  return REASONS[stopReason] ?? (stopReason ? `interrupted (${stopReason})` : "interrupted");
}

const LABELS: Readonly<Record<string, string>> = {
  stopped_by_user: "Stopped by you",
  stopped: "Stopped by the harness",
  drain: "Stopped: worker draining",
  limit: "Stopped: limit reached",
  worker_shutdown: "Stopped: worker restarted for a deploy",
  worker_lost: "Lost: the worker crashed",
  worker_restart: "Stopped: provider runtime restarted",
  error: "Failed",
};

/** Short label of a stop reason for the UI ("Stopped: worker restarted for a deploy"); the reason itself if unknown. */
export function backgroundStopLabel(stopReason: string): string {
  return LABELS[stopReason] ?? stopReason;
}

/** One line for the UI: "Background task finished · exit 0", "Background task stopped: worker restarted for a deploy". */
export function backgroundHeadline(outcome: BackgroundOutcome, stopReason: string, exitCode?: number): string {
  const exit = exitCode === undefined ? "" : ` · exit ${exitCode}`;
  if (outcome === "running") return "Background task running";
  if (outcome === "completed") return `Background task finished${exit}`;
  if (outcome === "failed" && (!stopReason || stopReason === "error")) return `Background task failed${exit}`;
  const label = backgroundStopLabel(stopReason || "stopped");
  return `Background task ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** Whether the stop was the user's (no wake-up turn for it: the note goes with the next turn). */
export function stoppedByUser(stopReason: string): boolean {
  return stopReason === "stopped_by_user";
}

/** "1 h 2 min", "3 min 5 s", "42 s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

/** The last lines of a task's output, bounded in lines and characters. */
export function outputTail(output: string, maxLines = 40, maxChars = 4_000): { text: string; truncated: boolean } {
  const trimmed = output.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  let text = lines.slice(-maxLines).join("\n");
  if (text.length > maxChars) text = text.slice(-maxChars);
  return { text, truncated: text.length < trimmed.length };
}

/** A task that ended, as the note tells it. */
export interface BackgroundTaskEnd {
  /** item_id of the background_task item: the id the agent's tools take. */
  readonly id: string;
  /** Short name: the description, else the command's first line. */
  readonly title: string;
  readonly command: string;
  readonly outcome: BackgroundOutcome;
  readonly stopReason: string;
  readonly exitCode?: number | undefined;
  readonly startedAt?: Date | undefined;
  readonly endedAt?: Date | undefined;
  /** Whole output (or as much as is stored); the note shows its tail. */
  readonly output: string;
}

/** Name of a task for people and models: its description, else its command's first line, else its id. */
export function backgroundTitle(task: { readonly description: string; readonly command: string; readonly taskId?: string }, fallback = ""): string {
  return (task.description || task.command || task.taskId || fallback).split("\n")[0]?.trim() || fallback;
}

/**
 * The platform note about tasks that ended (a turn of its own, or a steer into the running turn): which task, how it
 * ended and why, when, the exit code, the output's tail, and how to read more (`tools`: the agent has the bus tools).
 */
export function backgroundTaskNote(tasks: readonly BackgroundTaskEnd[], options: { tools: boolean; outputLines?: number } = { tools: true }): string {
  const one = tasks.length === 1;
  const head = one
    ? `[canopy] A background task of this thread ended: ${backgroundEndReason(tasks[0]!.outcome, tasks[0]!.stopReason, tasks[0]!.exitCode)}.`
    : `[canopy] ${tasks.length} background tasks of this thread ended.`;
  const sections = tasks.map((task) => {
    const lines = [`Task "${task.title}" (task_id: ${task.id})`];
    if (task.command && task.command !== task.title) lines.push(`Command: ${task.command.length > 500 ? `${task.command.slice(0, 500)}…` : task.command}`);
    lines.push(`Outcome: ${backgroundEndReason(task.outcome, task.stopReason, task.exitCode)}`);
    const times = [
      task.startedAt && `started ${task.startedAt.toISOString()}`,
      task.endedAt && `ended ${task.endedAt.toISOString()}`,
      task.startedAt && task.endedAt && `ran ${formatDuration(task.endedAt.getTime() - task.startedAt.getTime())}`,
    ].filter(Boolean);
    if (times.length > 0) lines.push(`When: ${times.join(", ")}`);
    if (task.stopReason === "worker_shutdown" || task.stopReason === "worker_lost" || task.stopReason === "worker_restart") {
      lines.push("It did not finish its work: start it again if it is still needed.");
    }
    const tail = outputTail(task.output, options.outputLines ?? (one ? 40 : 15));
    lines.push(tail.text ? `Output${tail.truncated ? " (last lines)" : ""}:\n\`\`\`\n${tail.text}\n\`\`\`` : "Output: (none)");
    return lines.join("\n");
  });
  const more = options.tools
    ? `Use get_background_task with the task_id for its status and more output, list_background_tasks for all tasks of this thread.`
    : "";
  return [head, ...sections, more].filter(Boolean).join("\n\n");
}
