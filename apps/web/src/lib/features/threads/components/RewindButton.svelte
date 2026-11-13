<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { previewRewind } from "../rewind-api.ts";
  import { useThreadRewind } from "../rewind-state.svelte.ts";

  let { threadId, turnId }: { threadId: string; turnId: string } = $props();
  const rewind = useThreadRewind();
  let open = $state(false);
  let preview = $state.raw<ui.ThreadRewindPreview>();
  let error = $state("");
  let loading = $state(false);
  let generation = 0;

  $effect(() => {
    if (!open) return;
    const current = ++generation;
    preview = undefined;
    error = "";
    loading = true;
    void previewRewind(threadId, turnId)
      .then((result) => {
        if (generation === current) preview = result;
      })
      .catch((cause) => {
        if (generation === current)
          error = cause instanceof Error ? cause.message : "Could not check this message. Reopen to retry.";
      })
      .finally(() => {
        if (generation === current) loading = false;
      });

    return () => {
      generation++;
    };
  });

  async function edit(files: boolean) {
    if (preview && (await rewind?.().edit(threadId, turnId, preview, files))) open = false;
  }
</script>

<Popover bind:open label="Edit from here" placement="bottom-end" class="w-80 max-w-[calc(100vw-2rem)]">
  {#snippet trigger(props)}
    <IconButton {...props} icon="arrow-uturn-left" size="sm" label="Edit from here" disabled={rewind?.().busy} />
  {/snippet}
  <div class="grid gap-3 p-3">
    <p class="text-sm/5 font-medium">Edit from here</p>
    {#if loading}<p class="text-xs/5 text-muted" role="status">Checking this message…</p>{/if}
    {#if error}<p class="text-xs/5 text-rose-700 dark:text-rose-400" role="alert">{error}</p>{/if}
    {#if preview}
      <p class="text-xs/5 text-muted">
        Rewind {preview.messages}
        {preview.messages === 1 ? "message" : "messages"} and edit this one. You can undo before sending again.
      </p>
      {#if preview.running || preview.backgroundTasks}
        <p class="text-xs/5 text-muted">The agent and its background tasks will stop.</p>
      {/if}
      <p class="text-xs/5 text-muted">Queued messages and pending requests will be cancelled.</p>
      {#if preview.filesAvailable}
        <details class="text-xs/5 text-muted">
          <summary class="cursor-pointer rounded focus-ring">Show files to restore ({preview.files.length})</summary>
          <ul class="mt-1 max-h-28 overflow-y-auto break-words">
            {#each preview.files as file}<li>{file}</li>{/each}
          </ul>
        </details>
        <p class="text-xs/5 text-muted">
          Checkpoints cover the agent's file edits. Shell commands and subagents are excluded.
        </p>
        <Button disabled={rewind?.().busy} onclick={() => void edit(true)}>Conversation and files</Button>
        <Button variant="ghost" disabled={rewind?.().busy} onclick={() => void edit(false)}>Conversation only</Button>
      {:else}
        <p class="text-xs/5 text-muted">Files stay as they are.</p>
        {#if preview.filesDetail !== "Files stay as they are."}<details class="text-xs/5 text-muted">
            <summary class="cursor-pointer rounded focus-ring">Show details</summary>{preview.filesDetail}
          </details>{/if}
        <Button loading={rewind?.().busy} onclick={() => void edit(false)}
          >{preview.running ? "Stop and edit" : "Edit from here"}</Button
        >
      {/if}
    {/if}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
  </div>
</Popover>
