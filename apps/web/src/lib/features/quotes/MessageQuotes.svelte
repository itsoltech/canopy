<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { isCodeQuote } from "@open-agents/domain";
  import type { ClassValue } from "svelte/elements";
  import { useThreadDirectory } from "#lib/features/threads/thread-directory.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";

  /**
   * The quotes of a message in its bubble: each a compact quote of the passage (its first lines) with the comment
   * under it. Pressing a quote scrolls to where it came from and highlights it, when it is still in this thread.
   */
  let { quotes, inverted = false, class: className }: { quotes: readonly ui.Quote[]; inverted?: boolean; class?: ClassValue } = $props();
  const directory = useThreadDirectory();

  async function show(quote: ui.Quote) {
    const found = (await directory.revealQuote?.(quote)) ?? false;
    if (!found) toast("The quoted passage is no longer in this thread", { tone: "error" });
  }
</script>

<ul role="list" class={["grid gap-2", className]}>
  {#each quotes as quote, index (index)}
    <!-- The quote and the comment on it hang off one rule, apart from the message below. -->
    <li class={["grid gap-0.5 border-l-2 pl-2.5", inverted ? "border-white/20 dark:border-zinc-950/15" : "border-zinc-950/15 dark:border-white/20"]}>
      {#if quote.sourceItemId && directory.revealQuote}
        <button
          type="button"
          class={["block w-full min-w-0 rounded-sm text-left focus-ring", inverted ? "text-zinc-300 hover:text-white dark:text-zinc-600 dark:hover:text-zinc-950" : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"]}
          title="Show where it was quoted from"
          onclick={() => show(quote)}
        >
          {@render passage(quote)}
        </button>
      {:else}
        <div class={inverted ? "text-zinc-300 dark:text-zinc-600" : "text-zinc-600 dark:text-zinc-400"}>{@render passage(quote)}</div>
      {/if}
      {#if quote.comment}<p class="whitespace-pre-wrap">{quote.comment}</p>{/if}
    </li>
  {/each}
</ul>

{#snippet passage(quote: ui.Quote)}
  <span class={["line-clamp-3 break-words", isCodeQuote(quote.sourceKind) ? "font-mono text-[0.8125rem]/5 whitespace-pre-wrap" : "whitespace-pre-line"]}>{quote.text}</span>
{/snippet}
