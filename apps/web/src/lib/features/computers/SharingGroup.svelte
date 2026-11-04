<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";

  /** The "Linked computers" card of a settings page (ShareSetting rows); absent until a computer is linked. */
  let { description = "Choose what stays the same on every linked computer.", class: className, children }: { description?: string; class?: ClassValue; children: Snippet } = $props();
  const overview = useOverview();
</script>

{#if overview.computers.size > 0}
  <SettingsGroup class={className} title="Linked computers" {description}>{@render children()}</SettingsGroup>
{/if}
