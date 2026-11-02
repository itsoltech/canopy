<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { LineReveal } from "#lib/shared/ui/streaming/line-reveal.svelte.ts";
  import { OUTPUT_LINE_HEIGHT, outputRange, OutputPin } from "./terminal-scroll.ts";
  import { terminalAnsi } from "./terminal-ansi.ts";

  /** A terminal tail with fixed-height virtual rows. Reading earlier output never moves with new lines. */
  let { output, running, exitLine, class: className }: { output: string; running: boolean; exitLine?: string | undefined; class?: ClassValue } = $props();
  const reveal = new LineReveal(() => output, () => running);
  const lines = $derived(reveal.text ? terminalAnsi(reveal.text) : []);
  const pin = new OutputPin();
  let pinned = $state(true);
  let top = $state(0);
  let height = $state(400);
  let viewport = $state<HTMLDivElement>();
  let lastHeight = 0;
  const range = $derived(outputRange(lines.length, top, height));
  const total = $derived((lines.length + 1) * OUTPUT_LINE_HEIGHT);

  export function latest() {
    if (!viewport?.clientHeight) return;
    pinned = true;
    lastHeight = viewport.clientHeight;
    viewport.scrollTop = pin.latest(viewport.clientHeight, viewport.scrollHeight);
    pin.top = viewport.scrollTop;
    top = viewport.scrollTop;
  }
  $effect(() => {
    void reveal.text;
    void height;
    void running;
    void exitLine;
    if (!pinned || !viewport) return;
    let active = true;
    void tick().then(() => { if (active && untrack(() => pinned)) untrack(latest); });
    return () => { active = false; };
  });
</script>

<div class={["relative flex min-h-0 min-w-0 flex-1", className]}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Keyboard scrolling and End belong to this labelled scroll region.) -->
  <div
    bind:this={viewport}
    bind:clientHeight={height}
    role="region"
    aria-label="Terminal output"
    tabindex="0"
    data-autofocus
    class="min-h-0 w-full overflow-auto overscroll-contain p-4 font-mono text-sm/5 text-zinc-200 focus-ring [overflow-anchor:none]"
    onscroll={() => {
      if (!viewport) return;
      // Resizing can clamp scrollTop upward; that is not a reader scrolling away from the tail.
      if (lastHeight !== viewport.clientHeight) {
        lastHeight = viewport.clientHeight;
        if (pinned) latest();
        else pin.top = viewport.scrollTop;
        top = viewport.scrollTop;
        return;
      }
      pin.scroll(viewport.scrollTop, viewport.clientHeight, viewport.scrollHeight);
      pinned = pin.pinned;
      top = viewport.scrollTop;
    }}
    onkeydown={(event) => {
      if (event.key === "End") { event.preventDefault(); latest(); }
    }}
  >
    {#if lines.length}
      <div style:height="{total}px" class="relative min-w-full w-max">
        <div style:transform="translateY({range[0] * OUTPUT_LINE_HEIGHT}px)" class="absolute inset-x-0 top-0">
          {#each lines.slice(range[0], range[1]) as line, index (range[0] + index)}
            <div class="h-5 whitespace-pre" data-output-line>{#each line as token}<span style:color={token.foreground} style:background-color={token.background} class={[token.bold && "font-semibold", token.dim && "opacity-60", token.italic && "italic", token.underline && "underline"]}>{token.text}</span>{/each}{#if !line.length}{"\u200b"}{/if}</div>
          {/each}
        </div>
        <div style:top="{lines.length * OUTPUT_LINE_HEIGHT}px" class="absolute inset-x-0 h-5 whitespace-pre text-zinc-400">{#if running}<span aria-hidden="true" class="inline-block h-4 w-2 translate-y-0.5 t-pulse bg-zinc-400"></span>{:else}{exitLine}{/if}</div>
      </div>
    {:else}
      <p class="text-zinc-400">{running ? "Waiting for output…" : "No output."}{#if running}<span aria-hidden="true" class="inline-block h-4 w-2 translate-y-0.5 t-pulse bg-zinc-400"></span>{/if}</p>
      {#if !running && exitLine}<p class="text-zinc-400">{exitLine}</p>{/if}
    {/if}
  </div>
  {#if !pinned}
    <div class="absolute inset-x-0 bottom-3 flex justify-center"><Button size="sm" icon="arrow-down" onclick={latest}>Jump to latest</Button></div>
  {/if}
</div>
