<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { replyFailure } from "../errors.ts";
  import type { ChatErrorView, ParticipantView } from "../model.ts";

  /**
   * A bot could not reply, as a quiet line where its answer would be: "Kropek couldn't reply — the model
   * isn't available." The technical cause is in the tooltip of the icon (and read to screen readers).
   * Retry runs your last message again; Change model appears when the model is the likely cause.
   */
  let {
    error,
    sender,
    retrying = false,
    onretry,
    onchangemodel,
    class: className,
  }: {
    error: ChatErrorView;
    sender: ParticipantView | undefined;
    retrying?: boolean;
    onretry?: (() => void) | undefined;
    onchangemodel?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const failure = $derived(replyFailure(error.detail));
</script>

<div class={["flex flex-col gap-2 pl-9 sm:flex-row sm:items-center sm:gap-3", className]}>
  <p class="flex min-w-0 items-start gap-1.5 text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
    <span class="flex h-lh shrink-0 items-center" {@attach tooltip(error.detail)}>
      <Icon name="exclamation-circle" class="text-rose-500 dark:text-rose-400" />
    </span>
    <span
      >{sender?.name ?? "The bot"} couldn't reply — {failure.reason}.<span class="sr-only">
        Details: {error.detail}</span
      ></span
    >
  </p>
  {#if error.retryable && (onretry || (failure.model && onchangemodel))}
    <div class="flex shrink-0 gap-2">
      {#if failure.model && onchangemodel}<Button size="sm" variant="ghost" onclick={onchangemodel}>Change model</Button
        >{/if}
      {#if onretry}<Button size="sm" icon="arrow-path" loading={retrying} onclick={onretry}>Retry</Button>{/if}
    </div>
  {/if}
</div>
