<script lang="ts">
  import { ui } from "@open-agents/contracts";
  import { create } from "@bufbuild/protobuf";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import FeedRowView from "#lib/features/threads/components/FeedRowView.svelte";
  import { measureMount, measureScroll, measureStream, toEnd, type BenchResult } from "#lib/features/threads/dev/bench.ts";
  import { longThreadSnapshot, streamingTurn } from "#lib/features/threads/dev/fixture.ts";
  import { provideThreadDirectory } from "#lib/features/threads/thread-directory.ts";
  import { ThreadState } from "#lib/features/threads/thread-state.svelte.ts";
  import { FeedBuilder, feedEstimate, feedGroup, type FeedRow } from "#lib/features/threads/feed.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import VirtualFeed from "#lib/shared/ui/virtual/VirtualFeed.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const snapshot = $derived(longThreadSnapshot({ turns: data.turns, inherited: data.inherited }));
  const view = $derived.by(() => {
    const state = new ThreadState();
    state.apply(create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } }));
    return state;
  });
  provideThreadDirectory({ currentId: "", thread: () => undefined, awaiting: () => false });

  const working = $derived(view.running);
  let historyOpen = $state(false);
  const builder = new FeedBuilder();
  const rows = $derived(
    builder.build({
      entries: view.ownEntries,
      turns: view.ownTurns,
      notices: view.notices,
      results: view.turnResults,
      queued: view.queued,
      working,
      forkSourceId: view.thread?.forkSourceThreadId,
      inheritedEntries: view.inheritedEntries,
      inheritedTurns: view.inheritedTurns,
      historyOpen,
    }),
  );

  let generation = $state(0);
  let running = $state(false);
  let result = $state<BenchResult>();

  // Hydrated: the benchmark button works (the runner waits for this).
  $effect(() => {
    (window as unknown as { __benchReady: boolean }).__benchReady = true;
  });

  async function run() {
    running = true;
    const mountMs = await measureMount(() => generation++);
    const target = document.querySelector<HTMLElement>("[data-bench-scroller] [role=region]")!;
    const nodes = target.querySelectorAll("*").length;
    const scroll = await measureScroll(target);
    await toEnd(target);
    const live = streamingTurn(snapshot, 200);
    for (const update of live.start) view.apply(update);
    const stream = await measureStream(target, (i) => {
      const update = live.deltas[i];
      if (update) view.apply(update);
      return Boolean(update);
    });
    for (const update of live.finish) view.apply(update);
    result = { rows: rows.length, nodes, mountMs, deltaAvgMs: stream.avg, deltaP95Ms: stream.p95, afterStreamGap: stream.gap, scrollFrameAvgMs: scroll.avg, scrollFrameMaxMs: scroll.max, longFrames: scroll.long };
    (window as unknown as { __bench: BenchResult }).__bench = result;
    running = false;
  }
</script>

<svelte:head><title>Long thread benchmark · Open Agents</title></svelte:head>

<div class="flex h-full min-w-0 flex-col">
  <TopBar>
    <Crumb><span class="truncate">{view.thread?.title}</span></Crumb>
    {#snippet actions()}
      <Button size="sm" loading={running} onclick={run}>Run benchmark</Button>
    {/snippet}
  </TopBar>
  {#if result}
    <pre class="mx-4 rounded-lg bg-zinc-950/5 p-2 text-xs/5 dark:bg-white/5" data-bench-result>{JSON.stringify(result)}</pre>
  {/if}

  <!-- Same structure as the thread page (the commit that added this route measured the one before virtualization). -->
  {#key generation}
    <div class="min-h-0 flex-1" data-bench-scroller>
      <VirtualFeed {rows} key={(row: FeedRow) => row.key} group={feedGroup} estimate={feedEstimate} label="Timeline" busy={working}>
        {#snippet row(row: FeedRow)}
          <FeedRowView {row} ontoggle={() => (historyOpen = !historyOpen)} />
        {/snippet}
        {#snippet footer()}
          <div class="pt-2"><div class="h-28 rounded-2xl ring-1 ring-zinc-950/10 dark:ring-white/10"></div></div>
        {/snippet}
      </VirtualFeed>
    </div>
  {/key}
</div>
