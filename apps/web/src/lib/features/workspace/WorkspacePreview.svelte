<script lang="ts">
  import { untrack } from "svelte";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { ThreadWorkspace } from "./thread-workspace.svelte.ts";
  import AgentPreviewPanel from "#lib/features/preview/AgentPreviewPanel.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";

  let {
    state,
    worker,
    active,
    location,
    offline = "",
    class: className,
  }: {
    state: ThreadWorkspace;
    worker?: ui.Worker;
    active: boolean;
    location: "sidebar" | "tab";
    offline?: string;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();
  const thread = $derived(overview?.threads.get(state.threadId()));

  // A linked computer's project and its logins stay on the gateway that owns them.
  const projectId = $derived(thread && !thread.nodeId ? thread.projectId : undefined);

  $effect.pre(() => {
    const choice = state.previewChoice;
    const workerId = worker?.id;

    if (!workerId) return;
    untrack(() => {
      if (choice.workerId && choice.workerId !== workerId) {
        choice.target = undefined;
        choice.selection = undefined;
      }

      choice.workerId = workerId;
    });
  });
</script>

<div class={["h-full min-h-0 min-w-0", className]}>
  {#key `${state.threadId()}:${worker?.id ?? ""}`}
    <AgentPreviewPanel
      threadId={state.threadId()}
      {projectId}
      {worker}
      {offline}
      {location}
      {active}
      selection={state.previewChoice.selection}
      onselectionfocus={() => (state.previewChoice.selection = undefined)}
      bind:tool={state.previewTool}
      bind:target={state.previewChoice.target}
      bind:fit={state.previewChoice.fit}
      onmove={(target) => {
        state.previewChoice.target = target;
        state.previewChoice.selection = { id: "workspace-preview", tool: state.previewTool, target };

        if (location === "sidebar") state.openPreviewTab();
        else state.showPanel("preview");
      }}
    />
  {/key}
</div>
