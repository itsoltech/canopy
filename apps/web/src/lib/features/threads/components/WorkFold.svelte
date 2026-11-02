<script lang="ts">
  import { formatSpan } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Rule from "#lib/shared/ui/Rule.svelte";
  import type { ClassValue } from "svelte/elements";
  import type { WorkSummary } from "../work-groups.ts";
  import type { ui } from "@open-agents/contracts";
  import { timestampMs } from "@bufbuild/protobuf/wkt";

  /**
   * Stable live/ended work header. A mounted live fold owns a one-second clock; historical folds have
   * no timers. The button keeps its place and focus when it opens; flattened work follows in the feed.
   */
  let { summary, turn, open, ontoggle, class: className }: { summary: WorkSummary; turn: ui.Turn; open: boolean; ontoggle: () => void; class?: ClassValue } = $props();
  let now = $state(Date.now());
  $effect(() => {
    if (!summary.live) return;
    now = Date.now();
    const timer = setInterval(() => now = Date.now(), 1000);
    return () => clearInterval(timer);
  });
  const span = $derived(summary.live && turn.startedAt ? Math.max(0, now - timestampMs(turn.startedAt)) : summary.spanMs);
  const label = $derived(summary.live ? "Working for" : summary.spanMs === undefined ? "Work" : "Worked for");
  // An ended turn whose fold holds nothing: the duration as plain text, no chevron, nothing to open.
  const empty = $derived(!summary.live && summary.size === 0);
</script>

{#snippet content()}
  <!-- The chevron's place stays (aligned with other folds), empty when there is nothing to open. -->
  <span class="flex h-lh w-4 shrink-0 items-center">
    {#if !empty}<Icon name="chevron-right" class={["t-acc-chevron fill-zinc-400 group-hover/fold:fill-zinc-500 dark:fill-zinc-500 dark:group-hover/fold:fill-zinc-400", open && "rotate-90"]} />{/if}
  </span>
  <span class="flex min-w-0 items-baseline gap-x-2">
    <span class={["shrink-0 font-medium", summary.live && "shimmer"]}>{label}{#if span !== undefined}&nbsp;<span class="tabular-nums">{formatSpan(span)}</span>{/if}</span>
    {#if summary.live}<span class="min-w-0 truncate text-zinc-400 dark:text-zinc-500" title={summary.hint}>{summary.hint}</span>
    {:else if summary.counts}<span class="min-w-0 truncate text-zinc-400 dark:text-zinc-500">{summary.counts}</span>{/if}
    {#if !summary.live && summary.running > 0}
      <!-- Baseline-aligned with the label (the dot is centred on its own, so it does not set the baseline). -->
      <span class="flex shrink-0 items-baseline gap-1.5 text-sky-700 tabular-nums dark:text-sky-400">
        <span class="size-1.5 shrink-0 self-center t-pulse rounded-full bg-current" aria-hidden="true"></span>{summary.running} still running
      </span>
    {/if}
  </span>
{/snippet}

<div class={["flex items-center gap-3", className]}>
  {#if empty}
    <div class="flex min-w-0 items-start gap-2 py-2.5 text-base/6 text-zinc-500 select-none sm:py-1 sm:text-sm/6 dark:text-zinc-400">{@render content()}</div>
  {:else}
    <button
      type="button"
      class="group/fold flex min-w-0 items-start gap-2 rounded-md py-2.5 text-left text-base/6 text-zinc-500 focus-ring select-none hover:text-zinc-800 sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:hover:text-zinc-200"
      aria-expanded={open}
      onclick={ontoggle}
    >{@render content()}</button>
  {/if}
  <Rule class="min-w-4" />
</div>
