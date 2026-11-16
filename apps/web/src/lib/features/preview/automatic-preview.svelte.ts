import { untrack } from "svelte";
import { create, equals } from "@bufbuild/protobuf";
import { AgentPreviewTargetSchema, type AgentPreviewTarget, type AgentTool, type ui } from "@canopy/contracts";
import type { ThreadState } from "#lib/features/threads/thread-state.svelte.ts";
import { threadCache } from "#lib/features/threads/thread-cache.ts";

export interface PreviewSelection {
  id: string;
  tool: AgentTool;
  target?: AgentPreviewTarget;
}

class PreviewMemory {
  selection = $state.raw<PreviewSelection>();
  minimized = $state(false);
  seen = "";

  constructor(readonly workerId: string) {}

  follow(activity: ui.ThreadAutomationActivity): void {
    const target = create(AgentPreviewTargetSchema, {
      id: activity.target,
      label: activity.app || activity.deviceId || activity.windowId,
      platform: activity.platform,
      deviceId: activity.deviceId,
      windowId: activity.windowId,
      app: activity.app,
    });

    if (
      this.selection?.tool === activity.tool &&
      this.selection.target &&
      equals(AgentPreviewTargetSchema, this.selection.target, target)
    )
      return;

    this.selection = {
      id: activity.id,
      tool: activity.tool,
      target,
    };
  }
}

// Session metadata only: no frames, snapshots or browser storage. Retained thread views have a
// separate, smaller budget; replacing one must not lose the user's mini preview choice.
const memories = new Map<string, PreviewMemory>();
const MEMORY_LIMIT = 32;

// A retained view can still expose its last live signal after access changes or cache eviction.
// Do not use that old signal to recreate a discarded selection.
const observed = new WeakSet<ui.ThreadAutomationActivity>();
let generation = $state(0);

threadCache.onRelease((id) => {
  if (id === undefined) memories.clear();
  else memories.delete(id);

  generation++;
});

function openMemory(id: string, workerId: string): PreviewMemory {
  const previous = memories.get(id);
  const memory = previous?.workerId === workerId ? previous : new PreviewMemory(workerId);
  memories.delete(id);
  memories.set(id, memory);

  if (memories.size > MEMORY_LIMIT) {
    const oldest = memories.keys().next().value;

    if (oldest !== undefined) memories.delete(oldest);
  }

  return memory;
}

/** Only live authorized activity can seed a choice; route remounts restore session metadata. */
export class AutomaticPreview {
  #memory = $state.raw<PreviewMemory>();
  readonly #source: () => ThreadState;

  // Route props update before the restoration effect runs. Never expose the previous thread's
  // choice to a newly rendered mini preview, even when both threads share the same worker.
  get #current(): PreviewMemory | undefined {
    void generation;
    const thread = this.#source().thread;
    const memory = this.#memory;

    return thread &&
      !thread.archivedAt &&
      !thread.deletedAt &&
      memory?.workerId === thread.workerId &&
      memories.get(thread.id) === memory
      ? memory
      : undefined;
  }

  get selection(): PreviewSelection | undefined {
    return this.#current?.selection;
  }
  get workerId(): string {
    return this.#current?.workerId ?? "";
  }
  get minimized(): boolean {
    return this.#current?.minimized ?? false;
  }
  set minimized(value: boolean) {
    const memory = this.#current;

    if (memory) memory.minimized = value;
  }

  constructor(source: () => ThreadState) {
    this.#source = source;

    $effect(() => {
      const view = source();
      const thread = view.thread;
      const activity = view.automationActivity;
      void generation;

      untrack(() => {
        if (!thread || thread.archivedAt || thread.deletedAt) {
          if (thread) memories.delete(thread.id);

          if (thread && activity) observed.add(activity);

          this.#memory = undefined;

          return;
        }

        const memory = openMemory(thread.id, thread.workerId);
        this.#memory = memory;

        if (!activity || observed.has(activity)) return;
        observed.add(activity);

        if (activity.workerId !== thread.workerId || activity.id === memory.seen) return;
        memory.seen = activity.id;
        memory.follow(activity);
      });
    });
  }
}
