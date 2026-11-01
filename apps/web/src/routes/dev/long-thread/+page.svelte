<script lang="ts">
  import { ui } from "@open-agents/contracts";
  import { create } from "@bufbuild/protobuf";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import InheritedHistory from "#lib/features/threads/components/InheritedHistory.svelte";
  import Timeline from "#lib/features/threads/components/Timeline.svelte";
  import { measureMount, measureScroll, measureStream, type BenchResult } from "#lib/features/threads/dev/bench.ts";
  import { longThreadSnapshot, streamingTurn } from "#lib/features/threads/dev/fixture.ts";
  import { provideThreadDirectory } from "#lib/features/threads/thread-directory.ts";
  import { ThreadState } from "#lib/features/threads/thread-state.svelte.ts";
  import { buildTimeline } from "#lib/features/threads/timeline.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const snapshot = $derived(longThreadSnapshot({ turns: data.turns, inherited: data.inherited }));
  const view = $derived.by(() => {
    const state = new ThreadState();
    state.apply(create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } }));
    return state;
  });
  provideThreadDirectory({ currentId: "", thread: () => undefined, awaiting: () => false });

  const rows = $derived(buildTimeline(view.ownEntries, view.ownTurns, view.notices, view.turnResults));
  const working = $derived(view.running);

  let scroller = $state<HTMLElement>();
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
    const target = scroller!;
    const nodes = target.querySelectorAll("*").length;
    const scroll = await measureScroll(target);
    target.scrollTop = target.scrollHeight;
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

  <!-- Same structure as the thread page before virtualization. -->
  {#key generation}
    <div class="relative min-h-0 flex-1">
      <div bind:this={scroller} class="h-full overflow-y-auto overscroll-contain" data-bench-scroller>
        <div class="mx-auto max-w-(--chat-width) px-4 pt-2 pb-6 sm:px-6">
          {#if view.inheritedTurns.length > 0 && view.thread?.forkSourceThreadId}
            <InheritedHistory sourceId={view.thread.forkSourceThreadId} entries={view.inheritedEntries} turns={view.inheritedTurns} results={view.turnResults} />
          {/if}
          <Timeline {rows} queued={view.queued} {working} />
        </div>
      </div>
    </div>
  {/key}
</div>
