<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";

  /** Replaces the composer in a bot ⇄ bot chat: you read along (only they write here) and close it. */
  let { onclose, class: className }: { onclose?: (() => void) | undefined; class?: ClassValue } = $props();
</script>

<div class={["flex flex-col items-center gap-2 py-1", className]}>
  <p class="text-center text-sm/5 text-pretty text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    Only the bots can write here.
  </p>
  {#if onclose}<Button onclick={onclose}>Close chat</Button>{/if}
</div>
