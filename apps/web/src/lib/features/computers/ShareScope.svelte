<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSharedConfig } from "./shared-config.svelte.ts";

  /**
   * Where a setting applies: on every linked computer or only here. Nothing without linked computers,
   * where everything is this computer's anyway. With `itemKey` it follows that item, including an open
   * question ("Choose a version"); `shared` alone states a fixed scope (connector accounts, desktop).
   */
  let {
    itemKey,
    shared = false,
    compact = false,
    class: className,
  }: { itemKey?: string; shared?: boolean; compact?: boolean; class?: ClassValue } = $props();

  const overview = useOverview();
  const sharing = useSharedConfig();
  const on = $derived(itemKey ? sharing.shared(itemKey) : shared);
  const conflicted = $derived(itemKey ? sharing.conflicts(itemKey).length > 0 : false);
</script>

{#if overview.computers.size > 0 && conflicted}
  <Badge tone="amber" icon="exclamation-triangle" {compact} class={className}>Choose a version</Badge>
{:else if overview.computers.size > 0}
  <Badge tone={on ? "sky" : "neutral"} icon={on ? "arrows-right-left" : "computer-desktop"} {compact} class={className}
    >{on ? "All linked computers" : "This computer"}</Badge
  >
{/if}
