<script lang="ts">
  import { onMount } from "svelte";
  import { timestampFromMs } from "@bufbuild/protobuf/wkt";
  import type { ui } from "@canopy/contracts";
  import { hasComposerContent } from "@canopy/domain/composer-drafts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { formatRelative } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { remoteDrafts } from "./remote.svelte.ts";
  import { webDrafts } from "./local.svelte.ts";
  import type { WebComposerDraft } from "./state.svelte.ts";
  import DraftsDialog from "./DraftsDialog.svelte";

  let {
    draft,
    threadId = "",
    disabled = false,
  }: { draft: WebComposerDraft; threadId?: string; disabled?: boolean } = $props();

  let open = $state(false);

  let newer = $derived(
    remoteDrafts.rows.find(
      (row) => row.target?.threadId === threadId && row.id !== draft.id && row.updatedAtMs > draft.publishedAtMs,
    ),
  );

  let busy = $state(false);
  let notice = $state("");

  async function refresh() {
    if (!threadId || !webDrafts.ready) return;

    try {
      await remoteDrafts.load();
    } catch {
      /* The local draft stays usable while disconnected. */
    }
  }

  async function publish() {
    busy = true;
    notice = "";

    try {
      await draft.publish();
      notice = "Draft ready on your other devices";
    } catch {
      draft.error =
        draft.files.blocker || draft.error || "Could not hand off this draft. Check the connection, then retry.";
    } finally {
      busy = false;
    }
  }

  async function take(incoming: ui.ComposerDraft, replace = false) {
    if (disabled || draft.locked) throw new Error("Finish the current composer action, then retry.");
    const composer = draft;
    busy = true;

    try {
      await composer.take(incoming, replace);
      remoteDrafts.invalidate();
      await remoteDrafts.load();
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    void threadId;
    void webDrafts.ready;
    void refresh();
  });

  onMount(() => remoteDrafts.subscribe());
</script>

<div class="flex min-w-0 flex-wrap items-center gap-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
  <Button size="sm" variant="ghost" onclick={() => (open = true)} {disabled}>Open drafts</Button>
  <Button
    size="sm"
    variant="ghost"
    onclick={() => void publish()}
    disabled={disabled ||
      busy ||
      Boolean(draft.files.blocker) ||
      Boolean(draft.pendingSend || draft.pendingForm) ||
      !hasComposerContent(draft.content())}
  >
    Continue on another device
  </Button>
  <p class="min-w-0 flex-1 truncate" role="status">{notice}</p>
</div>
{#if (draft.pendingSend || draft.pendingForm) && !draft.preparing && !draft.reconciling && draft.deliveryChecked}
  <div class="flex min-w-0 items-center gap-2 text-sm/5 text-zinc-500 dark:text-zinc-400">
    <p class="min-w-0 flex-1">
      Send not confirmed. The previous message may have been sent. Editing starts a new message.
    </p>
    <Button
      size="sm"
      variant="ghost"
      disabled={Boolean(draft.pendingForm) && draft.preparing}
      onclick={() => draft.cancelSend(true, true)}>Edit draft</Button
    >
    <Button
      size="sm"
      variant="ghost"
      disabled={Boolean(draft.pendingForm) && draft.preparing}
      onclick={() => {
        draft.cancelSend(true, true);
        draft.clear();
      }}>Discard draft</Button
    >
  </div>
{/if}
{#if newer}
  <div class="flex min-w-0 items-center gap-2 text-sm/5 text-zinc-500 dark:text-zinc-400">
    <p class="min-w-0 flex-1 truncate">
      Draft from {newer.deviceName} · {formatRelative(timestampFromMs(Number(newer.updatedAtMs)), clock.now)}
    </p>
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled || busy}
      onclick={() => {
        const incoming = newer;
        if (incoming)
          void take(incoming).catch(() => {
            draft.error = "Could not continue this draft. Open Drafts and retry.";
          });
      }}>Continue</Button
    >
  </div>
{/if}
{#if draft.error}<Alert tone="error">{draft.error}</Alert>{/if}
<DraftsDialog bind:open {draft} ontake={take} />
