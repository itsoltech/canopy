<script lang="ts">
  import { formatSpan } from "#lib/shared/format.ts";
  import FeedFold from "#lib/shared/ui/FeedFold.svelte";
  import LiveTime from "#lib/shared/ui/LiveTime.svelte";
  import { runningAnimation } from "#lib/shared/activity.ts";
  import { Settled } from "#lib/shared/settled.svelte.ts";
  import { WORK_HINT_SETTLE_MS } from "@canopy/domain/work-summary";
  import type { ClassValue } from "svelte/elements";
  import type { WorkSummary } from "../work-groups.ts";
  import type { ui } from "@canopy/contracts";

  /**
   * Stable live/ended work header. Only its visible duration text subscribes to the shared clock.
   * The button keeps its place and focus when it opens; flattened work follows in the feed.
   */
  let {
    summary,
    turn,
    open,
    ontoggle,
    class: className,
  }: { summary: WorkSummary; turn: ui.Turn; open: boolean; ontoggle: () => void; class?: ClassValue } = $props();

  const starting = $derived(turn.status === "queued" && turn.dispatched);

  const label = $derived(
    starting
      ? "Starting"
      : summary.live
        ? summary.startMs === undefined
          ? "Working"
          : "Working for"
        : summary.spanMs === undefined
          ? "Work"
          : "Worked for",
  );

  const hint = new Settled(() => summary.hint, WORK_HINT_SETTLE_MS);

  // An ended turn whose fold holds nothing: the duration as plain text, no chevron, nothing to open.
  const empty = $derived(!summary.live && summary.size === 0);
</script>

<FeedFold {empty} {open} {ontoggle} class={className}>
  <span class="flex min-w-0 items-baseline gap-x-2">
    <LiveTime
      active={summary.live && !starting && summary.startMs !== undefined}
      shimmer={summary.live}
      class="shrink-0 font-medium tabular-nums"
      format={(now) => {
        const span =
          summary.live && summary.startMs !== undefined ? Math.max(0, now - summary.startMs) : summary.spanMs;
        return `${label}${!starting && span !== undefined ? `\u00a0${formatSpan(span)}` : ""}`;
      }}
    />
    {#if summary.live && !starting}<span class="min-w-0 truncate text-zinc-400 dark:text-zinc-500" title={hint.current}
        >{hint.current}</span
      >
    {:else if summary.counts}<span class="min-w-0 truncate text-zinc-400 dark:text-zinc-500">{summary.counts}</span
      >{/if}
    {#if !summary.live && summary.running > 0}
      <!-- Baseline-aligned with the label (the dot is centred on its own, so it does not set the baseline). -->
      <span class="flex shrink-0 items-baseline gap-1.5 text-sky-700 tabular-nums dark:text-sky-400">
        <span
          class="t-pulse size-1.5 shrink-0 self-center rounded-full bg-current"
          aria-hidden="true"
          {@attach runningAnimation}
        ></span>{summary.running} still running
      </span>
    {/if}
  </span>
</FeedFold>
