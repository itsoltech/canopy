<script lang="ts">
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { usageTone } from "@canopy/domain/sidebar-usage";
  import type { ProviderUsageSnapshot } from "@canopy/contracts";
  import { activeUsageWindows, usageWindowName, usageReset, usageBillingNotice } from "@canopy/domain/provider-usage";
  import type { ClassValue } from "svelte/elements";

  let {
    usage,
    now = clock.now,
    class: className,
  }: { usage?: ProviderUsageSnapshot; now?: number; class?: ClassValue } = $props();

  const windows = $derived(activeUsageWindows(usage, now));
  const billing = $derived(usageBillingNotice(usage, now));
</script>

{#if windows.length || billing}
  <div class={["grid min-w-0 gap-2 text-sm/5 sm:text-xs/5", className]}>
    {#each windows as window (window.key)}
      <div class="grid min-w-0 gap-1">
        <div class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 tabular-nums">
          <span class="text-zinc-700 dark:text-zinc-300"
            >{usageWindowName(window.key)}{window.usedPercent !== undefined
              ? ` · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(window.usedPercent)}% used`
              : window.reached
                ? " · limit reached"
                : ""}</span
          >
          <span class="text-zinc-500 dark:text-zinc-400">{usageReset(window, true, now)}</span>
        </div>
        {#if window.usedPercent !== undefined}
          <div
            role="meter"
            aria-label={`${usageWindowName(window.key)} limit used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={window.usedPercent}
            class="h-1 overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10"
          >
            <div
              class={[
                "h-full rounded-full",
                usageTone(window.reached ? 100 : window.usedPercent) === "danger"
                  ? "bg-rose-600 dark:bg-rose-400"
                  : usageTone(window.usedPercent) === "warning"
                    ? "bg-amber-600 dark:bg-amber-400"
                    : "bg-zinc-500 dark:bg-zinc-400",
              ]}
              style:width={`${window.usedPercent}%`}
            ></div>
          </div>
        {/if}
      </div>
    {/each}
    {#if billing}<p role="status" class="text-amber-700 dark:text-amber-400">{billing}</p>{/if}
  </div>
{/if}
