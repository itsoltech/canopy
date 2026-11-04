<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import MoveItemLabel from "./MoveItemLabel.svelte";
  import MoveNotes from "./MoveNotes.svelte";

  /** One thread or bot in a move preview: whether it can move now, what goes along and what to redo there. */
  let { item, target, detailed = true, class: className }: { item: ui.MovePreviewItem; target: string; detailed?: boolean; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 grid-cols-1 gap-2 py-3", className]}>
  <div class="flex min-w-0 items-start gap-2">
    <MoveItemLabel kind={item.kind} title={item.title} detail={detailed ? "" : item.projectName} />
    {#if item.blocked}<Badge tone="amber" icon="no-symbol">Can't move now</Badge>
    {:else if item.archived}<Badge>Archived</Badge>{/if}
  </div>
  {#if item.blocked}<p class="text-base/6 text-pretty text-amber-800 sm:text-sm/6 dark:text-amber-300">{item.blocked}</p>
  {:else if detailed}
    <MoveNotes title="Moves along" items={item.moves} />
    <MoveNotes title={`To do again on ${target}`} icon="arrow-path" items={item.redo} />
  {/if}
</div>
