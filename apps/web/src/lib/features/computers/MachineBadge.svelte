<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";

  /**
   * The linked computer a thread, project or worker lives on. Nothing for this computer's own: the badge
   * marks the exception, so lists without linked computers look as before.
   */
  let { nodeId, compact = false, class: className }: { nodeId: string; compact?: boolean; class?: ClassValue } = $props();
  const overview = useOverview();
  const name = $derived(overview.machine(nodeId) ?? "");
</script>

{#if nodeId}
  <Badge icon="link" {compact} class={className ?? "max-w-40"}><span class="min-w-0 truncate" title="On {name}">{name}</span><span class="sr-only">, linked computer</span></Badge>
{/if}
