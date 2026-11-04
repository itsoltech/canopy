import type { ui } from "@canopy/contracts";
import type { Command } from "#lib/features/commands/registry.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { requestTitleRegeneration } from "./title-actions.ts";

/** What the thread page offers its palette commands: availability (read when the palette asks) and actions. */
export interface ThreadCommandContext {
  readonly working: boolean;
  readonly canBranch: boolean;
  readonly canFork: boolean;
  readonly canSchedule: boolean;
  readonly closed: boolean;
  readonly goalsHere: boolean;
  readonly canGoal: boolean;
  /** An open goal: the goal command replaces it. */
  readonly goalOpen: boolean;
  readonly stop: () => void;
  readonly openSide: () => void;
  readonly fork: () => void;
  readonly openSchedule: () => void;
  readonly openModel: () => void;
  readonly openPermissions: () => void;
  readonly setGoal: () => void;
  readonly togglePanel: () => void;
  /** The thread's page address. */
  readonly link: () => string;
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast("Copied");
  } catch {
    toast("Copying is not allowed here", { tone: "error" });
  }
}

/** The thread's actions in the command palette (the same as its menu, plus Interrupt while it works). */
export const threadCommands = (thread: ui.Thread, context: ThreadCommandContext): Command[] => [
  ...threadActionCommands(thread, context),
  ...threadDetailCommands(thread, context),
];

/** Side threads, fork, schedule, model, title, permissions and goal, plus Interrupt while it works. */
function threadActionCommands(current: ui.Thread, context: ThreadCommandContext): Command[] {
  return [
    {
      id: "thread:interrupt",
      title: "Interrupt",
      group: "actions",
      icon: "stop",
      keywords: "stop cancel turn",
      rank: -8,
      when: () => context.working,
      run: context.stop,
    },
    {
      id: "thread:side",
      title: "New side thread",
      group: "actions",
      icon: "arrows-right-left",
      keywords: "new side branch fork",
      rank: -7,
      when: () => context.canBranch,
      run: context.openSide,
    },
    {
      id: "thread:fork",
      title: "Fork thread",
      group: "actions",
      icon: "arrow-turn-up-right",
      keywords: "fork branch copy duplicate new chat",
      rank: -7,
      when: () => context.canFork,
      run: context.fork,
    },
    {
      id: "thread:schedule",
      title: "Schedule a task…",
      group: "actions",
      icon: "clock",
      keywords: "schedule later cron recurring",
      rank: -7,
      when: () => context.canSchedule,
      run: context.openSchedule,
    },
    {
      id: "thread:model",
      title: "Model and effort…",
      group: "actions",
      icon: "cpu-chip",
      keywords: "model reasoning effort",
      rank: -7,
      when: () => !context.closed,
      run: context.openModel,
    },
    {
      id: "thread:regenerate-title",
      title: "Regenerate title",
      group: "actions",
      icon: "arrow-path",
      keywords: "thread title generate name",
      rank: -7,
      when: () => !context.closed,
      run: () => requestTitleRegeneration(current.id),
    },
    {
      id: "thread:permissions",
      title: "Permissions…",
      group: "actions",
      icon: "shield-check",
      keywords: "permission mode approvals sandbox",
      rank: -7,
      when: () => !context.closed,
      run: context.openPermissions,
    },
    {
      id: "thread:goal",
      title: context.goalOpen ? "Replace the goal…" : "Set a goal…",
      group: "actions",
      icon: "flag",
      keywords: "goal objective",
      rank: -7,
      when: () => context.goalsHere,
      disabled: !context.canGoal,
      run: context.setGoal,
    },
  ];
}

/** The details panel and copying the thread's link, id and working directory. */
function threadDetailCommands(current: ui.Thread, context: ThreadCommandContext): Command[] {
  return [
    {
      id: "thread:details",
      title: "Toggle thread details",
      group: "actions",
      icon: "view-columns",
      keywords: "panel context sidebar",
      rank: -6,
      run: context.togglePanel,
    },
    {
      id: "thread:copy-link",
      title: "Copy thread link",
      group: "actions",
      icon: "link",
      keywords: "url share",
      rank: -6,
      run: () => copy(context.link()),
    },
    {
      id: "thread:copy-id",
      title: "Copy thread id",
      group: "actions",
      icon: "document-duplicate",
      keywords: "identifier",
      rank: -6,
      run: () => copy(current.id),
    },
    {
      id: "thread:copy-cwd",
      title: "Copy working directory",
      group: "actions",
      icon: "folder",
      keywords: "path cwd",
      rank: -6,
      suggested: false,
      run: () => copy(current.cwd),
    },
  ];
}
