<script lang="ts">
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";

  let {
    label,
    rank = 0,
    total = 5,
    display,
  }: { label: string; rank?: number; total?: number; display?: "name" | "bars" } = $props();

  const barCount = $derived(Math.max(total, 1));
  const barHeight = (index: number) => 5 + index * 2;

  // The icon uses a 16-unit scale. Longer provider scales must still fit its height.
  const scaleHeight = $derived(Math.max(16, barHeight(barCount - 1)));
</script>

<span class={["flex items-center", display === "bars" ? "h-(--icon-standard)" : "min-h-lh"]}>
  {#if (display ?? devicePreferences.values.effortDisplay) === "bars"}
    <span role="img" aria-label={label} title={label} class="flex items-end gap-0.5">
      {#each Array.from({ length: barCount }) as _, index (index)}<span
          aria-hidden="true"
          style:height="calc(var(--icon-standard) * {barHeight(index) / scaleHeight})"
          class={["w-1 rounded-sm bg-current", index > rank && "opacity-20"]}
        ></span>{/each}
    </span>
  {:else}
    <span class="[text-box:trim-both_cap_alphabetic]">{label}</span>
  {/if}
</span>
