<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import type { FeedViewport } from "#lib/shared/ui/virtual/viewport.ts";
  import { currentTurns, railTicks, type RailTurn } from "./turn-rail.ts";
  import TurnPreview from "./TurnPreview.svelte";

  let { turns, viewport, onjump, class: className }: {
    turns: readonly RailTurn[];
    viewport: FeedViewport;
    onjump: (row: number) => void;
    class?: ClassValue;
  } = $props();
  let track = $state<HTMLElement>();
  let anchor = $state<HTMLElement>();
  let height = $state(0);
  let selected = $state(0);
  let tab = $state(0);
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastClosed = 0;
  let hasOpened = false;
  const previewId = $props.id();
  const current = $derived(currentTurns(turns, viewport));
  const ticks = $derived(railTicks(turns.length, height));
  const preview = $derived(turns[Math.min(selected, turns.length - 1)]);
  const y = $derived((selected + 0.5) * height / Math.max(1, turns.length));

  $effect(() => {
    if (!track) return;
    const observer = new ResizeObserver(([entry]) => { height = entry?.contentRect.height ?? 0; });
    observer.observe(track);
    return () => observer.disconnect();
  });
  $effect(() => () => clearTimeout(timer));
  $effect(() => { if (open) hasOpened = true; else if (hasOpened) lastClosed = Date.now(); });

  function show(index: number, immediate = false) {
    selected = index;
    clearTimeout(timer);
    if (open) return;
    timer = setTimeout(() => { open = true; }, immediate || Date.now() - lastClosed < 400 ? 0 : 500);
  }
  function leave() {
    clearTimeout(timer);
    timer = setTimeout(() => { open = false; }, 200);
  }
  function jump(index: number) {
    const turn = turns[index];
    if (!turn) return;
    clearTimeout(timer);
    open = false;
    tab = index;
    onjump(turn.row);
  }
  function keydown(event: KeyboardEvent, index: number) {
    if (event.key === "Escape") { clearTimeout(timer); open = false; return; }
    let next: number;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = Math.min(turns.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = turns.length - 1;
    else return;
    event.preventDefault();
    tab = next;
    track?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus({ preventScroll: true });
  }
</script>

<nav aria-label="Conversation turns" class={["flex h-full min-h-0 items-center justify-center max-md:hidden", className]} data-turn-rail>
  <div bind:this={track} class="relative w-8 max-h-full min-h-0" style:height="{turns.length * 10}px">
    <div aria-hidden="true" class="pointer-events-none absolute inset-0">
      {#each ticks as mark (mark.start)}
        {@const active = mark.start < current[1] && mark.end > current[0]}
        {@const hovered = open && selected >= mark.start && selected < mark.end}
        {@const running = turns.slice(mark.start, mark.end).some((turn) => turn.running)}
        <span class={["t-rail-tick absolute left-2 h-0.5 w-2 rounded-full bg-zinc-300 dark:bg-zinc-600", (active || hovered) && "scale-x-200 bg-zinc-600 dark:bg-zinc-300", running && "t-pulse"]} style:top="{mark.y}px" data-current={active || undefined}></span>
      {/each}
    </div>
    <ol role="list" class="relative flex h-full flex-col" aria-label="Turns">
      {#each turns as turn, index (turn.id)}
        <li class="min-h-0 flex-1">
          <button type="button" class="group relative flex size-full cursor-pointer items-center rounded-sm focus-visible:outline-2 focus-visible:outline-blue-500" tabindex={index === Math.min(tab, turns.length - 1) ? 0 : -1}
            aria-label={`Turn ${turn.number}: ${turn.title}`} aria-current={index >= current[0] && index < current[1] ? "location" : undefined}
            aria-describedby={open && selected === index ? previewId : undefined}
            data-turn-id={turn.id} data-turn-index={index}
            onpointerenter={(event) => { if (event.pointerType === "mouse") show(index); }}
            onpointerleave={leave}
            onfocus={() => { tab = index; show(index, true); }} onblur={leave}
            onkeydown={(event) => keydown(event, index)} onclick={() => jump(index)}>
            <span aria-hidden="true" class="absolute left-1.5 h-0.5 w-4 rounded-full bg-zinc-600 opacity-0 group-focus-visible:opacity-100 dark:bg-zinc-300"></span>
          </button>
        </li>
      {/each}
    </ol>
    {#key selected}
      <span bind:this={anchor} class="pointer-events-none absolute left-0 h-px w-8" style:top="{y}px" aria-hidden="true"></span>
    {/key}
  </div>
  <Popover bind:open {anchor} label="Turn preview" placement="right-start" focusOnOpen={false} class="t-rail-preview">
    <div id={previewId} role="presentation" onpointerenter={() => clearTimeout(timer)} onpointerleave={leave}>
      {#if preview}<TurnPreview turn={preview} />{/if}
    </div>
  </Popover>
</nav>
