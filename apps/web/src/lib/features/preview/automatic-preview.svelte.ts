import { create } from "@bufbuild/protobuf";
import { AgentPreviewTargetSchema, AgentTool, type AgentPreviewTarget } from "@canopy/contracts";
import { SvelteMap } from "svelte/reactivity";
import type { ThreadState } from "#lib/features/threads/thread-state.svelte.ts";
import { threadCache } from "#lib/features/threads/thread-cache.ts";

export interface PreviewSelection {
  id: string;
  tool: AgentTool;
  target?: AgentPreviewTarget;
}

// Only a per-thread minimize preference survives leaving the screen. New activity supplies the source.
const minimized = new SvelteMap<string, string>();

threadCache.onRelease((id) => (id === undefined ? minimized.clear() : minimized.delete(id)));

export class AutomaticPreview {
  constructor(readonly source: () => ThreadState) {}

  readonly #current = $derived.by(() => {
    const view = this.source();
    const thread = view.thread;
    const current = view.previewActivity.current;

    return view.connection === "live" &&
      thread &&
      !thread.archivedAt &&
      !thread.deletedAt &&
      current?.activity.workerId === thread.workerId
      ? current
      : undefined;
  });

  readonly selection: PreviewSelection | undefined = $derived.by(() => {
    const activity = this.#current?.activity;

    if (!activity) return;
    const { id, tool } = activity;

    // Desktop follows one verified worker source through scoped snapshots and qualified ref actions.
    if (tool === AgentTool.DESKTOP) return { id, tool };

    const target = create(AgentPreviewTargetSchema, {
      id: activity.target,
      label: activity.app || activity.deviceId || activity.windowId,
      platform: activity.platform,
      deviceId: activity.deviceId,
      windowId: activity.windowId,
      app: activity.app,
    });

    return { id, tool, target };
  });

  get settled(): boolean {
    return this.#current?.settled ?? false;
  }
  get admissionId(): string {
    return this.#current?.admissionId ?? "";
  }
  get workerId(): string {
    return this.#current?.activity.workerId ?? "";
  }
  get turnId(): string {
    return this.#current?.activity.turnId ?? "";
  }
  get minimized(): boolean {
    const thread = this.source().thread;

    return Boolean(thread && minimized.get(thread.id) === thread.workerId);
  }
  set minimized(value: boolean) {
    const thread = this.source().thread;

    if (!thread) return;
    minimized.delete(thread.id);

    if (value) {
      minimized.set(thread.id, thread.workerId);

      if (minimized.size > 32) {
        const oldest = minimized.keys().next().value;

        if (oldest !== undefined) minimized.delete(oldest);
      }
    }
  }
}
