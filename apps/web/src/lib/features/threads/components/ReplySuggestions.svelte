<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { splitReplySuggestions } from "@canopy/domain/reply-suggestions";
  import Button from "#lib/shared/ui/Button.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { useThreadDirectory } from "../thread-directory.ts";

  let { source, class: className }: { source: { itemId: string; text: string }; class?: ClassValue } = $props();
  const directory = useThreadDirectory();
  const replies = $derived(splitReplySuggestions(source.text).replies);
  const state = $derived(directory.replySuggestions);
  const choice = $derived(state?.choice(source.itemId));
  const available = $derived(directory.canReply?.(source.itemId) ?? false);

  function send(text: string) {
    const threadId = directory.currentId;

    void state?.send(
      threadId,
      source.itemId,
      text,
      () => directory.currentId === threadId && (directory.canReply?.(source.itemId) ?? false),
      (response) => {
        if (directory.currentId === threadId) directory.messageSent?.(response);
      },
    );
  }
</script>

{#if replies.length}
  <div class={["grid min-w-0 gap-2", className]} data-quote-skip>
    <div
      class="flex min-w-0 flex-wrap gap-2"
      role="group"
      aria-label="Suggested replies"
      aria-busy={state?.sending || undefined}
    >
      {#each replies as reply (reply)}
        <div class="max-w-full min-w-0">
          <Button
            size="sm"
            disabled={!available || state?.sending || choice?.status !== "idle"}
            aria-label={reply}
            onclick={() => send(reply)}
          >
            <span class="flex min-w-0 items-start gap-1.5">
              <span class="min-w-0 text-left [overflow-wrap:anywhere] whitespace-normal">{reply}</span>
              <span class="flex h-lh shrink-0 items-center">
                {#if choice?.selected === reply && choice.status === "sending"}<Spinner class="size-3.5" />{:else}<Icon
                    name={choice?.selected === reply && choice.status === "sent" ? "check" : "arrow-up"}
                    class="size-3.5"
                  />{/if}
              </span>
            </span>
          </Button>
        </div>
      {/each}
    </div>
    {#if choice?.status === "error"}
      <div class="flex flex-wrap items-center gap-2">
        <p role="alert" class="text-sm/5 text-rose-700 dark:text-rose-400">{choice.failure}</p>
        {#if choice.retryable && available}<Button size="sm" variant="ghost" onclick={() => send(choice.selected)}
            >Retry</Button
          >{/if}
      </div>
    {/if}
  </div>
{/if}
