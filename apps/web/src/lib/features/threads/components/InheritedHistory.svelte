<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { TimelineRow } from "../timeline.ts";
  import ThreadLink from "./items/ThreadLink.svelte";
  import Timeline from "./Timeline.svelte";

  /**
   * The history a fork inherited from its source (turns up to the fork point), folded by default and
   * set apart from the fork's own turns, which follow the "Forked from" line.
   */
  let { sourceId, source, rows, turns }: { sourceId: string; source: ui.Thread | undefined; rows: readonly TimelineRow[]; turns: number } = $props();
</script>

<section aria-label="Inherited history" class="grid gap-3">
  <Disclosure class="rounded-xl bg-zinc-950/2.5 dark:bg-white/4" summaryClass="px-3 py-2.5 text-base/6 sm:py-2 sm:text-sm/6">
    {#snippet summary()}
      <span class="flex min-w-0 items-center gap-2">
        <span class="flex min-w-0 items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <Icon name="square-2-stack" class="fill-zinc-400 dark:fill-zinc-500" />
          <span class="truncate">History from “{source?.title ?? "the source thread"}”</span>
        </span>
        <span class="shrink-0 text-sm/6 text-zinc-500 tabular-nums sm:text-xs/6 dark:text-zinc-400">{turns} {turns === 1 ? "turn" : "turns"}</span>
      </span>
    {/snippet}
    <div class="px-3 pb-3 opacity-90">
      <Timeline {rows} />
    </div>
  </Disclosure>
  <div class="flex items-center gap-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    <span class="flex min-w-0 items-center gap-1.5"><span class="shrink-0">Forked from</span><ThreadLink threadId={sourceId} fallback="the source thread" /></span>
    <span class="h-px min-w-8 flex-1 bg-zinc-950/5 dark:bg-white/10"></span>
  </div>
</section>
