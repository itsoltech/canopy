<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "../Button.svelte";
  import { rise } from "../motion.ts";

  let { accessory, showJump, onjump }: { accessory?: Snippet; showJump: boolean; onjump: () => void } = $props();

  let row = $state<HTMLDivElement>();
  let jump = $state<HTMLSpanElement>();
  let status = $state<HTMLDivElement>();
  let shared = $state(false);
  let jumpWidth = 0;
  let statusWidth = 0;

  $effect(() => {
    const container = row;
    const jumpElement = jump;
    const statusElement = status;

    if (!container) return;

    const measure = () => {
      // Keep the last occupied widths when controls disappear, so the remaining control stays put.
      jumpWidth = jumpElement?.offsetWidth || jumpWidth;
      statusWidth = statusElement?.offsetWidth || statusWidth;
      const gap = parseFloat(getComputedStyle(container).columnGap);
      shared = container.clientWidth >= 2 * statusWidth + jumpWidth + 2 * gap;
    };

    const observer = new ResizeObserver(measure);
    observer.observe(container);

    if (jumpElement) observer.observe(jumpElement);

    if (statusElement) observer.observe(statusElement);

    measure();

    return () => observer.disconnect();
  });
</script>

{#if accessory || showJump}
  <div
    class="chat-column pointer-events-none absolute inset-x-0 bottom-[calc(var(--feed-edge)+--spacing(2))] z-10 px-4 sm:px-6"
  >
    <!-- The jump stays centred; the status shares its row only when it clears that centre slot. -->
    <div bind:this={row} class="grid grid-cols-1 items-end gap-2" data-shared={shared || undefined}>
      {#if showJump}
        <span
          bind:this={jump}
          class="pointer-events-auto col-start-1 row-start-1 flex w-max justify-self-center rounded-md bg-surface shadow-md ring-1 ring-divider"
          transition:rise
        >
          <Button size="sm" icon="arrow-down" onclick={onjump}>Jump to latest</Button>
        </span>
      {/if}
      {#if accessory}
        <div
          bind:this={status}
          class={[
            "pointer-events-auto col-start-1 min-h-7 w-max max-w-full min-w-0 justify-self-start",
            shared ? "row-start-1" : "row-start-2",
          ]}
        >
          {@render accessory()}
        </div>
      {/if}
    </div>
  </div>
{/if}
