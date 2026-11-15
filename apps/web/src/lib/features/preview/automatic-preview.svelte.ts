import { untrack } from "svelte";
import { create, equals } from "@bufbuild/protobuf";
import { AgentPreviewTargetSchema, type AgentPreviewTarget, type AgentTool, type ui } from "@canopy/contracts";
import type { ThreadState } from "#lib/features/threads/thread-state.svelte.ts";

export interface PreviewSelection {
  id: string;
  tool: AgentTool;
  target?: AgentPreviewTarget;
}

/** Only activity received while this page watches the thread can open the mini preview. */
export class AutomaticPreview {
  selection = $state<PreviewSelection>();
  workerId = $state("");
  minimized = $state(false);

  constructor(source: () => ThreadState) {
    let previous: ThreadState | undefined;
    let seen: string | undefined;

    $effect(() => {
      const view = source();
      const activity = view.automationActivity;

      if (view !== previous) {
        previous = view;
        seen = activity?.id;
        this.selection = undefined;
        this.workerId = "";
        this.minimized = false;

        return;
      }

      if (!activity || activity.id === seen) return;
      seen = activity.id;
      untrack(() => this.follow(activity));
    });
  }

  private follow(activity: ui.ThreadAutomationActivity): void {
    const target = create(AgentPreviewTargetSchema, {
      id: activity.target,
      label: activity.app || activity.deviceId || activity.windowId,
      platform: activity.platform,
      deviceId: activity.deviceId,
      windowId: activity.windowId,
      app: activity.app,
    });

    if (
      this.workerId === activity.workerId &&
      this.selection?.tool === activity.tool &&
      this.selection.target &&
      equals(AgentPreviewTargetSchema, this.selection.target, target)
    )
      return;

    this.workerId = activity.workerId;
    this.selection = {
      id: activity.id,
      tool: activity.tool,
      target,
    };
  }
}
