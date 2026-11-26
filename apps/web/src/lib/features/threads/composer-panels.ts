import type { ui } from "@canopy/contracts";
import type { TaskList } from "@canopy/domain/task-list";

/**
 * What the compact composer says about its folded panels (goal, tasks, subagents, queue), most active first;
 * undefined when it has none.
 */
export function composerPanelsLabel(
  queued: number,
  agents: number,
  goal: ui.Goal | undefined,
  tasks: TaskList | undefined,
): string | undefined {
  if (queued > 0 || agents > 0) return `${agents} agents · ${queued} queued`;

  if (goal) return "Goal";

  return tasks ? "Tasks" : undefined;
}
