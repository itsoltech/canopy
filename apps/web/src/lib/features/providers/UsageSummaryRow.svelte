<script lang="ts">
  import {
    bindingText,
    percentLeftText,
    summaryWindowText,
    usageSummaryLabel,
    type UsageSummaryRow,
  } from "@canopy/domain/usage-summary";
  import type { UsageTone } from "@canopy/domain/sidebar-usage";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";

  /** One provider: % left with one bar, the window and its reset, and a shorter window only when it binds. */
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

  const fill = (left: number) =>
    left <= 10
      ? "bg-rose-600 dark:bg-rose-400"
      : left <= 30
        ? "bg-amber-600 dark:bg-amber-400"
        : "bg-zinc-500 dark:bg-zinc-400";

  const toneOf = (left: number): UsageTone => (left <= 10 ? "danger" : left <= 30 ? "warning" : "neutral");
</script>

<li class="grid min-w-0 gap-1.5 tabular-nums" aria-label={usageSummaryLabel(row, clock.now)}>
  <div class="flex min-w-0 items-center gap-2" aria-hidden="true">
    {#if provider}<ProviderIcon {provider} size="sm" />{/if}
    <span class="min-w-0 flex-1 truncate text-base font-medium sm:text-sm">{row.name}</span>
    {#if row.word}<span class={["shrink-0 text-sm sm:text-xs", text(row.tone)]}>{row.word}</span>{/if}
    {#if row.window}<span class={["shrink-0 text-base font-medium sm:text-sm", text(toneOf(row.window.percentLeft))]}
        >{percentLeftText(row.window)}</span
      >{/if}
  </div>
  <div class="h-1 overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10" aria-hidden="true">
    {#if row.window}
      <div
        class={["h-full rounded-full", fill(row.window.percentLeft)]}
        style:width={`${row.window.percentLeft}%`}
      ></div>
    {:else}
      <div class="h-full w-full rounded-full bg-violet-600 dark:bg-violet-400"></div>
    {/if}
  </div>
  <div class="flex min-h-5 min-w-0 justify-between gap-2 text-sm/5 sm:text-xs/5" aria-hidden="true">
    <span class="min-w-0 truncate text-zinc-500 dark:text-zinc-400"
      >{row.window ? summaryWindowText(row.window, clock.now) : ""}</span
    >
    {#if row.binding}<span class={["shrink-0", text(toneOf(row.binding.percentLeft))]}>{bindingText(row.binding)}</span
      >{/if}
  </div>
</li>
