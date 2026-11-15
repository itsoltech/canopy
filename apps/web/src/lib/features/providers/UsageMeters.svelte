<script lang="ts">
  import { clock } from "#lib/shared/clock.svelte.ts";
  import type { ProviderUsageSnapshot } from "@canopy/contracts";
  import { activeUsageWindows, usageBillingNotice } from "@canopy/domain/provider-usage";
  import type { ClassValue } from "svelte/elements";
  import UsageMeter from "./UsageMeter.svelte";

  let {
    usage,
    now = clock.now,
    showPace = false,
    class: className,
  }: { usage?: ProviderUsageSnapshot; now?: number; showPace?: boolean; class?: ClassValue } = $props();

  const windows = $derived(activeUsageWindows(usage, now));
  const billing = $derived(usageBillingNotice(usage, now));
</script>

{#if windows.length || billing}
  <div class={["grid min-w-0 gap-2 text-sm/5 sm:text-xs/5", className]}>
    {#each windows as window (`${window.key}:${window.windowMinutes}`)}
      <UsageMeter {window} {now} {showPace} />
    {/each}
    {#if billing}<p role="status" class="text-amber-700 dark:text-amber-400">{billing}</p>{/if}
  </div>
{/if}
