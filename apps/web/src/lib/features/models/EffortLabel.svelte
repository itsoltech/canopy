<script lang="ts">
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

  let { label, rank = 0, total = 5 }: { label: string; rank?: number; total?: number } = $props();
</script>

{#if devicePreferences.values.effortDisplay === "bars"}
  <span role="img" aria-label={label} title={label} class="inline-flex h-4 items-end gap-0.5">
    {#each Array.from({ length: Math.max(total, 1) }) as _, index (index)}<span
        aria-hidden="true"
        style:height="{5 + index * 2}px"
        class={["w-1 rounded-sm bg-current", index > rank && "opacity-20"]}
      ></span>{/each}
  </span>
{:else}{label}{/if}
