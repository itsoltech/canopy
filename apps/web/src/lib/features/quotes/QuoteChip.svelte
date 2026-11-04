<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { quoteLabel, type QuoteDraft } from "./quote.ts";

  /**
   * One quote in a composer: the quote icon, the beginning of the passage (all of it and the comment on hover), a
   * pencil to edit the comment (brand-coloured when there is one) and a remove button. Delete or Backspace on
   * either button removes it too.
   */
  let {
    quote,
    editing = false,
    onedit,
    onremove,
    class: className,
  }: {
    quote: QuoteDraft;
    editing?: boolean;
    onedit: (anchor: HTMLElement) => void;
    onremove: () => void;
    class?: ClassValue;
  } = $props();

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    onremove();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (Delete/Backspace bubble up from the chip's buttons) -->
<div
  class={[
    "flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-lg bg-zinc-50 pl-2 text-sm/5 text-zinc-700 ring-1 ring-zinc-950/10 ring-inset sm:max-w-80 dark:bg-white/5 dark:text-zinc-300 dark:ring-white/10",
    className,
  ]}
  title={quote.comment ? `${quote.text}\n\nComment: ${quote.comment}` : quote.text}
  {onkeydown}
>
  <Icon name="chat-bubble-bottom-center-text" class="fill-zinc-400 dark:fill-zinc-500" />
  <span class="min-w-0 truncate">{quoteLabel(quote.text, 40)}</span>
  {#if quote.comment}<span class="sr-only">, with a comment</span>{/if}
  <span class="flex shrink-0 items-center">
    <IconButton
      icon="pencil-square"
      label={quote.comment ? "Edit the comment" : "Add a comment"}
      size="sm"
      iconClass={quote.comment ? "fill-brand-600 dark:fill-brand-400" : undefined}
      aria-haspopup="dialog"
      aria-expanded={editing}
      onclick={(event) => onedit(event.currentTarget)}
    />
    <IconButton icon="x-mark" label="Remove the quote" size="sm" data-quote-remove={quote.id} onclick={onremove} />
  </span>
</div>
