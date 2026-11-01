<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import type { BotView } from "../model.ts";

  /** Replaces the composer in a watched bot ⇄ bot chat: you read along, and can close the chat. */
  let { bots, onclose, class: className }: { bots: readonly BotView[]; onclose?: (() => void) | undefined; class?: ClassValue } = $props();
  const names = $derived(new Intl.ListFormat("en", { type: "conjunction" }).format(bots.map((b) => b.name)));
</script>

<div class={["flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl bg-zinc-950/2.5 px-4 py-3 ring-1 ring-zinc-950/5 dark:bg-white/5 dark:ring-white/10", className]}>
  <p class="min-w-0 text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
    You are watching {names}. Only they write here.
  </p>
  {#if onclose}<Button icon="x-mark" onclick={onclose}>Close chat</Button>{/if}
</div>
