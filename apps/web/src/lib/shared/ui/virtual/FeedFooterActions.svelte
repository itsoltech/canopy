<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "../Button.svelte";
  import { rise } from "../motion.ts";

  let { accessory, showJump, onjump }: { accessory?: Snippet; showJump: boolean; onjump: () => void } = $props();
</script>

{#if accessory || showJump}
  <!-- Separate rows keep the status close to the composer and the jump centred at any width. -->
  <div
    class="chat-column pointer-events-none absolute inset-x-0 bottom-[calc(var(--feed-edge)+--spacing(2))] z-10 flex flex-col items-start gap-2 px-4 sm:px-6"
  >
    {#if showJump}
      <span
        class="pointer-events-auto flex self-center rounded-md bg-surface shadow-md ring-1 ring-divider"
        transition:rise
      >
        <Button size="sm" icon="arrow-down" onclick={onjump}>Jump to latest</Button>
      </span>
    {/if}
    {#if accessory}
      <div class="pointer-events-auto min-h-7 max-w-full min-w-0">{@render accessory()}</div>
    {/if}
  </div>
{/if}
