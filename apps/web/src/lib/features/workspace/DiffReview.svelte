<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import type { DiffState } from "./diff-state.svelte.ts";

  let {
    state,
    disabled = false,
    class: className,
  }: { state: DiffState; disabled?: boolean; class?: ClassValue } = $props();

  const review = $derived(state.review);
  const stale = $derived(review.draft.comments.some((comment) => comment.snapshotId !== state.snapshotId));
  const id = $props.id();
</script>

<Dialog
  bind:open={review.open}
  title="Review changes"
  size="lg"
  fullscreen
  class={className}
  description="Send all comments as one message in this thread."
>
  <div class="space-y-4">
    {#if stale}
      <Alert tone="warning">Some comments refer to earlier changes. The review includes their original lines.</Alert>
    {/if}
    {#if review.draft.pending}
      <Alert tone="warning"
        >The previous send is unconfirmed. Retry the saved review, or add comments for a later review.</Alert
      >
    {/if}
    {#if review.notice}<Alert tone="warning">{review.notice}</Alert>{/if}
    {#if review.error}<Alert tone="error">{review.error}</Alert>{/if}
    {#if disabled}<Alert tone="warning">This thread cannot receive messages. Reopen it or choose another thread.</Alert
      >{/if}
    <div class="space-y-1.5">
      <label for={`${id}-summary`} class="text-base font-medium sm:text-sm"
        >Summary <span class="font-normal text-muted">(optional)</span></label
      >
      <Textarea
        id={`${id}-summary`}
        name="review-summary"
        rows={3}
        maxlength={4000}
        disabled={Boolean(review.draft.pending)}
        value={review.draft.summary}
        oninput={(event) => review.save(event.currentTarget.value)}
      />
    </div>
    {#if !review.draft.comments.length}
      <p class="text-base text-muted sm:text-sm">Choose a line number in the diff to add a comment.</p>
    {/if}
    {#each review.draft.comments as comment, index (comment.id)}
      <section class="min-w-0 space-y-2 border-t border-divider pt-4">
        <div class="flex min-w-0 items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="text-base font-medium wrap-anywhere select-text sm:text-sm">{comment.path}</p>
            <p class="text-sm text-muted sm:text-xs">
              {comment.side === "old" ? "Original" : "Changed"} line {comment.line.toLocaleString()}{comment.snapshotId !==
              state.snapshotId
                ? " · Earlier changes"
                : ""}
            </p>
          </div>
          <IconButton
            icon="trash"
            label="Remove comment"
            size="sm"
            disabled={review.locked(comment.id)}
            onclick={() => review.remove(comment.id)}
          />
        </div>
        <pre
          class="max-h-32 overflow-auto rounded-md bg-zinc-950/4 px-3 py-2 font-mono text-sm wrap-anywhere whitespace-pre-wrap select-text dark:bg-white/5">{comment.source}</pre>
        <label for={`${id}-${comment.id}`} class="sr-only">Comment {index + 1}</label>
        <Textarea
          id={`${id}-${comment.id}`}
          name={`review-comment-${comment.id}`}
          rows={3}
          maxlength={4000}
          data-autofocus={index === review.draft.comments.length - 1 ? "" : undefined}
          disabled={review.locked(comment.id)}
          value={comment.text}
          oninput={(event) => review.edit(comment.id, event.currentTarget.value)}
        />
      </section>
    {/each}
  </div>
  {#snippet footer()}
    <div class="flex flex-wrap items-center justify-end gap-2">
      <Button variant="ghost" onclick={() => (review.open = false)}>Keep draft</Button>
      <Button
        variant="primary"
        loading={review.sending}
        disabled={disabled ||
          (!review.draft.comments.length && !review.draft.summary.trim()) ||
          (review.draft.pending?.comments ?? review.draft.comments).some((comment) => !comment.text.trim())}
        onclick={() => review.send()}>{review.draft.pending ? "Retry review" : "Send review"}</Button
      >
    </div>
  {/snippet}
</Dialog>
