<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { pop, reorder } from "#lib/shared/ui/motion.ts";
  import type { QuoteDraft } from "./quote.ts";
  import { useQuoteDrafts } from "./quote-drafts.svelte.ts";
  import QuoteChip from "./QuoteChip.svelte";
  import QuoteCommentPopover from "./QuoteCommentPopover.svelte";

  /**
   * The quotes a message will carry, inside the composer above the text (next to the attachments tray): a chip
   * per quote with the beginning of the passage, a pencil that reopens the comment popover and a remove button.
   * Delete or Backspace on a focused chip button removes it too; focus moves to a neighbour. Chips pop in as Cite
   * adds them and the others glide aside when one goes (like the attachment chips).
   */
  let { threadId, class: className }: { threadId: string; class?: ClassValue } = $props();
  const drafts = useQuoteDrafts();
  const quotes = $derived(drafts.list(threadId));

  let editing = $state<{ quote: QuoteDraft; anchor: HTMLElement }>();
  let open = $state(false);
  let list = $state<HTMLUListElement>();

  function edit(quote: QuoteDraft, anchor: HTMLElement) {
    editing = { quote, anchor };
    open = true;
  }

  function remove(quote: QuoteDraft) {
    // Focus stays in the tray: the next chip's remove button, else the previous one (found before it goes).
    const index = quotes.findIndex((q) => q.id === quote.id);
    const neighbour = quotes[index + 1] ?? quotes[index - 1];
    drafts.remove(threadId, quote.id);
    if (neighbour) queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-quote-remove="${neighbour.id}"]`)?.focus());
  }
</script>

{#if quotes.length > 0}
  <ul bind:this={list} role="list" class={["flex flex-wrap gap-2", className]} aria-label="Quotes">
    {#each quotes as quote (quote.id)}
      <li class="max-w-full min-w-0" in:pop out:pop={{}} animate:reorder>
        <QuoteChip {quote} editing={open && editing?.quote.id === quote.id} onedit={(anchor) => edit(quote, anchor)} onremove={() => remove(quote)} />
      </li>
    {/each}
  </ul>
{/if}

{#if editing}
  <QuoteCommentPopover
    bind:open
    anchor={editing.anchor}
    quote={editing.quote.text}
    comment={editing.quote.comment}
    placement="top-start"
    onsave={(comment) => editing && drafts.edit(threadId, editing.quote.id, comment)}
    onclosed={() => (editing = undefined)}
  />
{/if}
