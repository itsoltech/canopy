<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { baseName } from "#lib/features/projects/placement.ts";
  import Button from "#lib/shared/ui/Button.svelte";

  /** Home and directories already used by projects on this worker. Paths remain available in tooltips. */
  let { locations, disabled = false, onopen, class: className }: {
    locations: readonly string[];
    disabled?: boolean;
    onopen: (path: string) => void;
    class?: ClassValue;
  } = $props();
</script>

<div class={["flex min-w-0 flex-wrap items-center gap-2", className]} aria-label="Directory shortcuts">
  <Button size="sm" {disabled} onclick={() => onopen("")}>Home</Button>
  {#each locations as location (location)}
    <div class="min-w-0 max-w-48">
      <Button size="sm" class="max-w-full" title={location} {disabled} onclick={() => onopen(location)}>
        <span class="truncate">{baseName(location)}</span>
      </Button>
    </div>
  {/each}
</div>
