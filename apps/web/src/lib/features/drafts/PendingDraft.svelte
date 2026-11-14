<script lang="ts">
  import type { WebComposerDraft } from "./state.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let { draft }: { draft: WebComposerDraft } = $props();
</script>

{#if (draft.pendingSend || draft.pendingForm) && !draft.preparing && !draft.reconciling && draft.deliveryChecked}
  <div class="flex min-w-0 items-center gap-2 text-sm/5 text-zinc-500 dark:text-zinc-400">
    <p class="min-w-0 flex-1">
      Send not confirmed. The previous message may have been sent. Editing starts a new message.
    </p>
    <Button size="sm" variant="ghost" onclick={() => draft.cancelSend(true, true)}>Edit draft</Button>
    <Button
      size="sm"
      variant="ghost"
      onclick={() => {
        draft.cancelSend(true, true);
        draft.clear();
      }}>Discard draft</Button
    >
  </div>
{/if}
{#if draft.error}<Alert tone="error">{draft.error}</Alert>{/if}
