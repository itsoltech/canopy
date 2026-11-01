<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { TimelineEntry, TurnResult } from "../thread-state.svelte.ts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import { buildTimeline } from "../timeline.ts";
  import ThreadLink from "./items/ThreadLink.svelte";
  import Timeline from "./Timeline.svelte";

  /**
   * The history a fork inherited (turns up to the fork point), folded by default and set apart from the
   * fork's own turns, which follow the "Forked from" line. A fork of a fork inherits from several
   * threads: each part is labelled with the thread it belongs to (`from_thread_id`), oldest first.
   */
  let {
    sourceId,
    entries,
    turns,
    results,
  }: { sourceId: string; entries: readonly TimelineEntry[]; turns: readonly ui.Turn[]; results: ReadonlyMap<string, TurnResult> } = $props();

  const directory = useThreadDirectory();
  const parts = $derived.by(() => {
    const order = [...new Set([...turns.map((t) => t.fromThreadId || sourceId), ...entries.map((e) => e.fromThreadId || sourceId)])];
    return order.map((threadId) => ({
      threadId,
      rows: buildTimeline(
        entries.filter((e) => (e.fromThreadId || sourceId) === threadId),
        turns.filter((t) => (t.fromThreadId || sourceId) === threadId),
        [],
        results,
      ),
    }));
  });
  const title = (id: string) => directory.thread(id)?.title;
  const heading = $derived.by(() => {
    if (parts.length <= 1) return `History from “${title(parts[0]?.threadId ?? sourceId) ?? "the source thread"}”`;
    return `History from ${parts.length} threads`;
  });
</script>

<section aria-label="Inherited history" class="grid gap-3">
  <Disclosure class="rounded-xl bg-zinc-950/2.5 dark:bg-white/4" summaryClass="px-3 py-2.5 text-base/6 sm:py-2 sm:text-sm/6">
    {#snippet summary()}
      <span class="flex min-w-0 items-center gap-2">
        <span class="flex min-w-0 items-center gap-2 text-zinc-700 dark:text-zinc-300">
          <Icon name="square-2-stack" class="fill-zinc-400 dark:fill-zinc-500" />
          <span class="truncate">{heading}</span>
        </span>
        <span class="shrink-0 text-sm/6 text-zinc-500 tabular-nums sm:text-xs/6 dark:text-zinc-400">{turns.length} {turns.length === 1 ? "turn" : "turns"}</span>
      </span>
    {/snippet}
    <div class="grid gap-4 px-3 pb-3 opacity-90">
      {#each parts as part (part.threadId)}
        <div class="grid gap-1">
          {#if parts.length > 1}
            <p class="flex items-center gap-1.5 pt-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
              <span class="shrink-0">From</span><ThreadLink threadId={part.threadId} fallback="an earlier thread" />
            </p>
          {/if}
          <Timeline rows={part.rows} />
        </div>
      {/each}
    </div>
  </Disclosure>
  <div class="flex items-center gap-3 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    <span class="flex min-w-0 items-center gap-1.5"><span class="shrink-0">Forked from</span><ThreadLink threadId={sourceId} fallback="the source thread" /></span>
    <span class="h-px min-w-8 flex-1 bg-zinc-950/5 dark:bg-white/10"></span>
  </div>
</section>
