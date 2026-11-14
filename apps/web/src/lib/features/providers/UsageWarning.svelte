<script lang="ts">
  import { onMount } from "svelte";
  import type { ProviderUsageSnapshot } from "@canopy/contracts";
  import { usageWarnings } from "@canopy/domain/provider-usage";
  import type { ClassValue } from "svelte/elements";

  let { usage, href, class: className }: { usage?: ProviderUsageSnapshot; href: string; class?: ClassValue } = $props();
  let now = $state(Date.now());
  const warnings = $derived(usageWarnings(usage, now));

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);

    return () => clearInterval(timer);
  });
</script>

{#if warnings.length}
  <div
    role="status"
    class={["grid min-w-0 gap-0.5 text-sm/5 text-amber-700 sm:text-xs/5 dark:text-amber-400", className]}
  >
    {#each warnings as warning (warning)}<p class="text-pretty tabular-nums">{warning}</p>{/each}
    <a class="w-fit underline underline-offset-2" {href}>Check usage in provider settings</a>
  </div>
{/if}
