<script lang="ts">
  import type { UsageGlance } from "@canopy/domain/sidebar-usage";
  import type { ClassValue } from "svelte/elements";

  let { glance, class: className }: { glance: readonly UsageGlance[]; class?: ClassValue } = $props();
</script>

<span aria-hidden="true" class={["grid w-5 gap-1", className]}>
  {#each glance as item (item.provider)}
    <span class="relative h-1 overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10">
      <span
        class={[
          "absolute inset-y-0 left-0 min-w-0.5 rounded-full",
          item.tone === "extra"
            ? "bg-violet-600 dark:bg-violet-400"
            : item.tone === "danger"
              ? "bg-rose-600 dark:bg-rose-400"
              : item.tone === "warning"
                ? "bg-amber-600 dark:bg-amber-400"
                : "bg-zinc-500 dark:bg-zinc-400",
        ]}
        style:width={`${item.tone === "extra" ? 100 : (item.percent ?? 0)}%`}
      ></span>
      {#if item.tone === "extra"}<span class="absolute inset-y-0 left-2 w-0.5 bg-surface"></span>{/if}
    </span>
  {/each}
</span>
