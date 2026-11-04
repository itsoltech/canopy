<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { BotView } from "../model.ts";

  /** Replaces the composer in a bot ⇄ bot chat: you read along (only they write here) and close it. */
  let {
    bots,
    onclose,
    class: className,
  }: { bots: readonly BotView[]; onclose?: (() => void) | undefined; class?: ClassValue } = $props();

  const names = $derived(new Intl.ListFormat("en", { type: "conjunction" }).format(bots.map((b) => b.name)));
</script>

<div class={["flex flex-col items-center gap-2 py-1", className]}>
  <p class="text-center text-sm/5 text-pretty text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    A conversation between {names}. Only they write here.
  </p>
  {#if onclose}<Button icon="x-mark" onclick={onclose}>Close chat</Button>{/if}
</div>
