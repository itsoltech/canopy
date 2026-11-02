<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { exchangePhrases, type ExchangeSegment } from "../chat-timeline.ts";
  import BotChip from "./BotChip.svelte";

  /**
   * Bot ⇄ bot messages as one quiet line instead of their text: "Messaged ‹A› and ‹B›", "Message from ‹A›",
   * "2 messages with ‹A›". Each bot links to that exchange (`hrefOf`), which opens as its own chat.
   */
  let { segments, hrefOf, class: className }: { segments: readonly ExchangeSegment[]; hrefOf: (segment: ExchangeSegment) => string; class?: ClassValue } = $props();
  const phrases = $derived(exchangePhrases(segments));
  const unknown = { id: "", kind: "bot", name: "a deleted bot" } as const;
</script>

{#snippet chip(segment: ExchangeSegment)}
  <BotChip bot={segment.bot ?? { ...unknown, id: segment.botId }} href={hrefOf(segment)} />
{/snippet}

<p class={["flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-9 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400", className]}>
  <Icon name="arrows-right-left" class="shrink-0 fill-zinc-400 dark:fill-zinc-500" />
  {#each phrases as phrase, index (index)}
    {#if index > 0}<span aria-hidden="true">·</span>{/if}
    {#if phrase.kind === "sent"}
      <span>Messaged</span>
      {#each phrase.segments as segment, i (segment.exchangeId + segment.botId)}
        {#if i > 0}<span>{i === phrase.segments.length - 1 ? "and" : ","}</span>{/if}
        {@render chip(segment)}
      {/each}
    {:else if phrase.kind === "received"}
      <span>Message from</span>
      {@render chip(phrase.segment)}
    {:else}
      <span class="tabular-nums">{phrase.count} messages with</span>
      {@render chip(phrase.segment)}
    {/if}
  {/each}
</p>
