<script lang="ts">
  import { accountsText, type UsageSummaryRow } from "@canopy/domain/usage-summary";
  import type { UsageTone } from "@canopy/domain/sidebar-usage";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import UsageSummaryMeter from "./UsageSummaryMeter.svelte";

  /**
   * One provider: a bar per window with its reset and % left. Each shorter window some account reports (e.g.
   * 5-hour) sits above the main window's bar, with each account's column in the same place in every bar.
   */
  let { row }: { row: UsageSummaryRow } = $props();
  const provider = $derived(providerKeyOf(row.provider));

  const text = (tone: UsageTone) =>
    tone === "extra"
      ? "text-violet-700 dark:text-violet-400"
      : tone === "danger"
        ? "text-rose-600 dark:text-rose-400"
        : tone === "warning"
          ? "text-amber-700 dark:text-amber-400"
          : "text-zinc-700 dark:text-zinc-300";
</script>

<li class="grid min-w-0 gap-1.5 tabular-nums">
  <div class="flex min-w-0 items-center gap-2">
    {#if provider}<ProviderIcon {provider} size="sm" />{/if}
    <span class="flex min-w-0 flex-1 items-baseline gap-2">
      <span class="min-w-0 truncate text-base font-medium sm:text-sm">{row.name}</span>
      {#if accountsText(row)}<span class="shrink-0 text-sm text-zinc-500 sm:text-xs dark:text-zinc-400"
          >{accountsText(row)}</span
        >{/if}
    </span>
    {#if row.word}<span class={["shrink-0 text-sm sm:text-xs", text(row.tone)]}>{row.word}</span>{/if}
  </div>
  {#if row.window}
    <div class="grid min-w-0 gap-2">
      {#if row.fiveHourPlaceholder.length}
        <UsageSummaryMeter segments={row.fiveHourPlaceholder} />
      {/if}
      {#each row.shorter as meter (meter.window.minutes)}
        <UsageSummaryMeter segments={meter.segments} window={meter.window} />
      {/each}
      <UsageSummaryMeter segments={row.segments} window={row.window} />
    </div>
  {:else}
    <div class="h-1 w-full rounded-full bg-violet-600 dark:bg-violet-400" aria-hidden="true"></div>
    <div class="min-h-5" aria-hidden="true"></div>
  {/if}
</li>
