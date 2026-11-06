<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { splitId } from "@canopy/domain/computers";
  import { computerName, sharesThreads } from "@canopy/domain/computer-presence";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import FileChip from "./FileChip.svelte";

  /** Blob metadata is mirrored; file contents stay at home and are fetched on demand. */
  let {
    entityId,
    name,
    children,
    class: className,
  }: { entityId: string; name: string; children: Snippet; class?: ClassValue } = $props();

  const overview = useOverview();
  const node = $derived(splitId(entityId).node);
  const computer = $derived(node ? [...overview.computers.values()].find((c) => c.nodeId.startsWith(node)) : undefined);
  const away = $derived(Boolean(node) && (!computer || !sharesThreads(computer)));
</script>

<div class={className}>
  {#if away}
    <FileChip
      {name}
      detail="Available when {computerName(computer)} is connected."
      class="max-w-80 rounded-xl p-3 ring-1 ring-zinc-950/10 dark:ring-white/10"
    />
  {:else}
    {@render children()}
  {/if}
</div>
