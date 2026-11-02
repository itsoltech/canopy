<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { LineReveal } from "#lib/shared/ui/streaming/line-reveal.svelte.ts";
  import { OUTPUT_LINE_HEIGHT, outputRange, OutputPin } from "../background-tasks.ts";

  /** A terminal tail with fixed-height virtual rows. Reading earlier output never moves with new lines. */
  let { output, running, class: className }: { output: string; running: boolean; class?: ClassValue } = $props();
  const reveal = new LineReveal(() => output, () => running);
  const lines = $derived(reveal.text ? reveal.text.replace(/\n$/, "").split("\n") : []);
  const pin = new OutputPin();
  let pinned = $state(true);
  let top = $state(0);
  let height = $state(400);
  let viewport = $state<HTMLDivElement>();
  const range = $derived(outputRange(lines.length, top, height));
  const total = $derived(lines.length * OUTPUT_LINE_HEIGHT);

  export function latest() {
    if (!viewport?.clientHeight) return;
    pinned = true;
    viewport.scrollTop = pin.latest(viewport.clientHeight, total);
    pin.top = viewport.scrollTop;
    top = viewport.scrollTop;
  }
  $effect(() => {
    void reveal.text;
    void height;
    if (!pinned || !viewport) return;
    let active = true;
    void tick().then(() => { if (active && untrack(() => pinned)) untrack(latest); });
    return () => { active = false; };
  });
</script>

<div class={["relative min-w-0", className]}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Keyboard scrolling and End belong to this labelled scroll region.) -->
  <div
    bind:this={viewport}
    bind:clientHeight={height}
    role="region"
    aria-label="Background task output"
    tabindex="0"
    data-autofocus
    style:overflow-anchor="none"
    class="h-[calc(100dvh-17rem)] min-h-32 overflow-auto overscroll-contain rounded-lg bg-zinc-950/2.5 font-mono text-xs/5 text-zinc-800 focus-ring sm:h-[min(55dvh,36rem)] dark:bg-white/5 dark:text-zinc-200"
    onscroll={() => {
      if (!viewport) return;
      pin.scroll(viewport.scrollTop, viewport.clientHeight, total);
      pinned = pin.pinned;
      top = viewport.scrollTop;
    }}
    onkeydown={(event) => {
      if (event.key === "End") { event.preventDefault(); latest(); }
    }}
  >
    {#if lines.length}
      <div style:height="{total}px" class="relative min-w-full w-max">
        <div style:transform="translateY({range[0] * OUTPUT_LINE_HEIGHT}px)" class="absolute inset-x-0 top-0 px-3">
          {#each lines.slice(range[0], range[1]) as line, index (range[0] + index)}
            <div class="h-5 whitespace-pre" data-output-line>{line || "\u200b"}</div>
          {/each}
        </div>
      </div>
    {:else}
      <p class="p-3 text-zinc-500">{running ? "Waiting for output…" : "No output."}</p>
    {/if}
  </div>
  {#if !pinned}
    <div class="absolute inset-x-0 bottom-3 flex justify-center"><Button size="sm" icon="arrow-down" onclick={latest}>Jump to latest</Button></div>
  {/if}
</div>
