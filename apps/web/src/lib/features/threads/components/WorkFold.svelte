<script lang="ts">
  import { formatSpan } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Rule from "#lib/shared/ui/Rule.svelte";
  import type { ClassValue } from "svelte/elements";
  import type { WorkSummary } from "../work-groups.ts";
  import type { ui } from "@open-agents/contracts";
  import { timestampMs } from "@bufbuild/protobuf/wkt";

  /**
   * An ended turn's work folded into one row: "Worked for 2m 14s", what it holds and how much of it is
   * still running (background tasks). The button keeps its place (and focus) when it opens or closes;
   * the rows it opens follow it in the feed.
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
</script>

<div class={["flex items-center gap-3", className]}>
  <button
    type="button"
    class="group/fold flex min-w-0 items-start gap-2 rounded-md py-2.5 text-left text-base/6 text-zinc-500 focus-ring select-none hover:text-zinc-800 sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:hover:text-zinc-200"
    aria-expanded={open}
    onclick={ontoggle}
  >
    <span class="flex h-lh shrink-0 items-center">
      <Icon name="chevron-right" class={["t-acc-chevron fill-zinc-400 group-hover/fold:fill-zinc-500 dark:fill-zinc-500 dark:group-hover/fold:fill-zinc-400", open && "rotate-90"]} />
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
  </button>
  <Rule class="min-w-4" />
</div>
