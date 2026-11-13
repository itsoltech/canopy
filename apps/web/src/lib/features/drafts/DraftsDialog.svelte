<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { timestampFromMs } from "@bufbuild/protobuf/wkt";
  import { goto } from "$app/navigation";
  import { composerTargetKey, hasComposerContent } from "@canopy/domain/composer-drafts";
  import { DEFAULT_ATTACHMENT_LIMITS } from "@canopy/domain";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { formatRelative } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { webDrafts } from "./local.svelte.ts";
  import { deleteDraft } from "./api.ts";
  import { remoteDrafts } from "./remote.svelte.ts";
  import type { WebComposerDraft } from "./state.svelte.ts";

  let {
    open = $bindable(false),
    draft,
    ontake,
  }: {
    open?: boolean;
    draft: WebComposerDraft;
    ontake: (incoming: ui.ComposerDraft, replace?: boolean) => Promise<void>;
  } = $props();

  let rows = $derived(remoteDrafts.rows);
  let next = $derived(remoteDrafts.next);
  let loading = $state(false);
  let error = $state("");
  let deleting = $state<ui.ComposerDraft>();
  let deleteOpen = $state(false);
  let sequence = 0;

  async function load(more = false) {
    const ticket = ++sequence;
    loading = true;
    error = "";

    try {
      await remoteDrafts.load(more);

      if (ticket !== sequence || !open) return;
    } catch {
      if (ticket === sequence) error = "Could not load drafts. Check the connection, then retry.";
    } finally {
      if (ticket === sequence) loading = false;
    }
  }

  async function remove(row: ui.ComposerDraft) {
    loading = true;

    try {
      await deleteDraft(row, row.takenByDeviceId || row.deviceId);
      remoteDrafts.invalidate();
      deleteOpen = false;
      await load();
    } catch {
      error = "Could not delete this draft. Refresh the list, then retry.";
      loading = false;
    }
  }

  async function take(row: ui.ComposerDraft, replace = false) {
    if (!row.target) return;
    error = "";
    loading = true;

    try {
      const currentTarget = webDrafts.local.list().find((entry) => entry.draft?.id === draft.id)?.draft?.target;

      if (currentTarget && composerTargetKey(currentTarget) === composerTargetKey(row.target))
        await ontake(row, replace);
      else {
        const destination = webDrafts.get(row.target, () => DEFAULT_ATTACHMENT_LIMITS);

        await destination.take(row, replace);

        const path = row.target.threadId
          ? `/threads/${encodeURIComponent(row.target.threadId)}`
          : row.target.parentThreadId
            ? `/threads/${encodeURIComponent(row.target.parentThreadId)}/new-side-thread`
            : `/?project=${encodeURIComponent(row.target.projectId)}&workspace=${encodeURIComponent(row.target.workspaceId)}`;

        await goto(path);
      }

      open = false;
    } catch {
      error = "Could not continue this draft. Refresh the list, then retry.";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (!open) return;
    void load();

    return remoteDrafts.subscribe();
  });
</script>

<Dialog bind:open title="Drafts" description="Continue a prompt from another device.">
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if !rows.length}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      {loading ? "Loading drafts…" : "No drafts from other devices"}
    </p>{/if}
  <ul role="list" class="grid max-h-[60dvh] gap-3 overflow-y-auto">
    {#each rows as row (row.id)}
      <li class="grid min-w-0 gap-1 border-b border-zinc-950/8 pb-3 text-base/6 sm:text-sm/5 dark:border-white/10">
        <p class="truncate font-medium text-zinc-950 dark:text-white">{row.title}</p>
        <p class="truncate text-zinc-500 dark:text-zinc-400">
          {row.deviceName} · {formatRelative(timestampFromMs(Number(row.updatedAtMs)), clock.now)}
        </p>
        <p class="line-clamp-2 break-words text-zinc-600 dark:text-zinc-300">{row.content?.text}</p>
        {#if row.content?.attachments.length}
          <p class="text-zinc-500 dark:text-zinc-400">
            {row.content.attachments.length}
            {row.content.attachments.length === 1 ? "attachment" : "attachments"}
          </p>
          <div class="flex gap-1 overflow-hidden">
            {#each row.content.attachments.filter((a) => a.hasThumbnail).slice(0, 4) as file (file.id)}
              <img
                src="/api/attachments/{encodeURIComponent(file.id)}?thumbnail"
                alt={file.name}
                class="size-10 rounded object-cover"
                loading="lazy"
              />
            {/each}
          </div>
        {/if}
        <div class="flex flex-wrap gap-1">
          <Button size="sm" disabled={loading} onclick={() => void take(row)}>Continue here</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onclick={() => {
              deleting = row;
              deleteOpen = true;
            }}>Delete draft</Button
          >
          {#if row.target && hasComposerContent(webDrafts.local.get(row.target)?.draft?.content)}
            <Button size="sm" variant="ghost" disabled={loading} onclick={() => void take(row, true)}
              >Replace local draft</Button
            >
          {/if}
        </div>
      </li>
    {/each}
  </ul>
  <div class="flex gap-2">
    <Button size="sm" variant="ghost" disabled={loading} onclick={() => void load()}>Refresh drafts</Button>
    {#if next}<Button size="sm" variant="ghost" disabled={loading} onclick={() => void load(true)}>Load more</Button
      >{/if}
  </div>
</Dialog>
<Dialog
  bind:open={deleteOpen}
  title="Delete draft?"
  description="This deletes the saved prompt. Local drafts on your devices stay available."
>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div class="flex justify-end gap-2">
    <Button variant="ghost" data-autofocus onclick={() => (deleteOpen = false)}>Cancel</Button>
    <Button
      variant="danger"
      disabled={loading}
      onclick={() => {
        if (deleting) void remove(deleting);
      }}>Delete draft</Button
    >
  </div>
</Dialog>
