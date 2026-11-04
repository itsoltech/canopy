<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { movedProjects, targetWorkspaces } from "./moves.ts";
  import MoveNotes from "./MoveNotes.svelte";
  import MovePlacementField from "./MovePlacementField.svelte";
  import MovePreviewItem from "./MovePreviewItem.svelte";

  /**
   * What a move would do: a workspace on the target for each moved project, every thing with what goes along
   * or why it can't move now, and (everything) the configuration that stays shared or stays here.
   */
  let {
    preview,
    target,
    targetName,
    everything = false,
    placements = $bindable({}),
    class: className,
  }: {
    preview: ui.MovePreview;
    target: string;
    targetName: string;
    everything?: boolean;
    placements?: Record<string, string | undefined>;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();
  const projects = $derived(movedProjects(preview));
</script>

<div class={["grid min-w-0 grid-cols-1 gap-5", className]}>
  {#if preview.unavailable}<Alert tone="warning">{preview.unavailable}</Alert>{/if}
  {#each projects as project (project.id)}
    <MovePlacementField
      project={project.name}
      target={targetName}
      options={targetWorkspaces(overview.projects, target, project)}
      bind:value={placements[project.id]}
    />
  {/each}
  <div class="divide-y divide-zinc-950/5 dark:divide-white/10">
    {#each preview.items as item (item.id)}<MovePreviewItem {item} target={targetName} detailed={!everything} />{/each}
  </div>
  {#if everything}
    <MoveNotes title={`Stays shared with ${targetName}`} icon="link" items={preview.shared} />
    <MoveNotes
      title={`Stays on this computer, set it up again on ${targetName}`}
      icon="computer-desktop"
      items={preview.localOnly}
    />
  {/if}
</div>
