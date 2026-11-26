import { getContext, setContext } from "svelte";
import type { ThreadWorkspace } from "#lib/features/workspace/thread-workspace.svelte.ts";
import { backgroundName, type BackgroundEntry } from "./background-tasks.ts";

const KEY = Symbol("background-output");

/** Timeline items open the same live output dialog as the panel and composer chip. */
export const provideBackgroundOutput = (open: (itemId: string) => void) => setContext(KEY, open);
export const useBackgroundOutput = (): ((itemId: string) => void) | undefined => getContext(KEY);

/**
 * Opens a task's output as a workspace tab (on a narrow window the side panel yields to it) and provides it to
 * the timeline. Returns the opener for the panel and composer chip.
 */
export function provideThreadOutput(
  workspace: ThreadWorkspace,
  tasks: () => readonly BackgroundEntry[],
): (itemId: string) => void {
  const open = (id: string) => {
    if (!workspace.wide) workspace.panelOpen = false;
    const task = tasks().find((entry) => entry.id === id);
    workspace.view.openModule({
      module: "tasks",
      resource: id,
      label: task ? backgroundName(task.item.content.value) : "Task output",
    });
  };

  provideBackgroundOutput(open);

  return open;
}
