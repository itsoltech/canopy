<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { removeWorktree, revealWorktree } from "./api.ts";

  let {
    entry,
    onchange,
    class: className,
  }: { entry: ui.WorktreeEntry; onchange: () => void; class?: ClassValue } = $props();

  const overview = useOverview();
  let confirm = $state(false);
  let working = $state(false);
  let error = $state("");
  const offline = $derived(!entry.online || !overview.worker(entry.worktree?.workerId ?? "")?.online);
  const unavailable = $derived(offline || !entry.status || Boolean(entry.status.detail) || entry.removed);

  const reason = $derived(
    offline
      ? "Worker offline. Reconnect it to manage this worktree."
      : unavailable
        ? entry.detail
        : entry.busy
          ? "A thread is still using this worktree."
          : "",
  );

  async function remove() {
    if (!entry.worktree || !entry.status) return;
    working = true;
    error = "";

    try {
      await removeWorktree(entry.worktree.id, entry.confirmationRequired, entry.status.headCommit);
      confirm = false;
      onchange();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not remove the worktree. Try again.";
    } finally {
      working = false;
    }
  }

  async function reveal() {
    if (!entry.worktree) return;
    working = true;
    error = "";

    try {
      await revealWorktree(entry.worktree.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not open the directory. Try again.";
    } finally {
      working = false;
    }
  }
</script>

<div class={["grid gap-2", className]}>
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">Open in…</span>
    <CopyButton text={entry.worktree?.path ?? ""} label="Copy worktree path" />
    <Button size="sm" variant="ghost" disabled={unavailable || working} onclick={reveal}>Reveal on computer</Button>
    <Button
      size="sm"
      variant="ghost"
      disabled={unavailable || entry.busy || working}
      onclick={() => {
        error = "";
        confirm = true;
      }}>Remove…</Button
    >
  </div>
  {#if reason}<p class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">{reason}</p>{/if}
  {#if error && !confirm}<Alert tone="error">{error}</Alert>{/if}
</div>

<Dialog bind:open={confirm} title="Remove worktree?" dismissible={!working}>
  <div class="grid gap-4">
    <p class="text-base text-zinc-600 sm:text-sm dark:text-zinc-300">
      Remove <code class="font-mono break-all">{entry.worktree?.branch}</code> from this computer. Thread history stays available.
    </p>
    {#if entry.confirmationRequired}
      <Alert tone="warning"
        >This worktree has {entry.status?.dirtyFiles ?? 0} changed {(entry.status?.dirtyFiles ?? 0) === 1
          ? "file"
          : "files"}{entry.status?.unpushed ? " and unpushed commits" : ""}. Removing it deletes the uncommitted files
        for good. Canopy keeps the local branch, so you can recover its commits.</Alert
      >
    {:else}
      <p class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
        The worker checks again for changes and active threads first. Your cleanup settings may also delete a safe local
        branch.
      </p>
    {/if}
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button disabled={working} onclick={() => (confirm = false)}>Cancel</Button>
      <Button variant="danger" loading={working} disabled={offline || entry.busy} onclick={remove}>
        {entry.confirmationRequired ? "Discard local files and remove" : "Remove worktree"}
      </Button>
    </DialogActions>
  </div>
</Dialog>
