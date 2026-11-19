<script lang="ts">
  import type { GitRefs, ui } from "@canopy/contracts";
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { HttpError } from "#lib/shared/http.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import RefPicker from "./RefPicker.svelte";
  import { listGitRefs } from "./api.ts";
  import { continueThreadInWorktree } from "./continue-thread.ts";

  let {
    open = $bindable(false),
    thread,
    disabled = false,
  }: { open?: boolean; thread: ui.Thread; disabled?: boolean } = $props();

  let refs = $state<GitRefs>();
  let baseRef = $state("");
  let loading = $state(false);
  let starting = $state(false);
  let error = $state("");
  let request = $state<{ baseRef: string; id: string }>();
  let generation = 0;

  async function load() {
    const current = ++generation;
    loading = true;
    error = "";

    try {
      const result = await listGitRefs(thread.workspaceId);

      if (generation !== current) return;

      if (!result.supported || !result.refs) {
        error = result.detail || "This computer cannot create worktrees. Update Canopy, then retry.";

        return;
      }

      refs = result.refs;

      const candidates = [
        request?.baseRef,
        thread.worktree?.branch,
        thread.worktree?.baseRef,
        refs.defaultBranch,
        refs.currentBranch,
      ];

      baseRef =
        candidates.find((name) => name && refs?.refs.some((ref) => ref.name === name)) ?? refs.refs[0]?.name ?? "";
    } catch (cause) {
      if (generation === current)
        error = cause instanceof Error ? cause.message : "Could not load branches. Check the connection, then retry.";
    } finally {
      if (generation === current) loading = false;
    }
  }

  $effect(() => {
    if (!open) return;
    untrack(() => {
      if (request) {
        baseRef = request.baseRef;
        error = "";

        return;
      }

      refs = undefined;
      void load();
    });

    return () => {
      generation++;
    };
  });

  async function start() {
    if (starting || disabled || !refs || !baseRef) return;
    starting = true;
    error = "";

    // A retry after a lost response must reuse the same request, including after reopening the dialog.
    if (!request || request.baseRef !== baseRef) request = { baseRef, id: crypto.randomUUID() };

    try {
      const created = await continueThreadInWorktree(thread.id, baseRef, request.id);
      open = false;
      await goto(`/threads/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      if (cause instanceof HttpError && cause.status < 500 && ![408, 429].includes(cause.status)) request = undefined;
      error = cause instanceof Error ? cause.message : "Could not create the worktree. Try again.";
    } finally {
      starting = false;
    }
  }
</script>

<Dialog
  bind:open
  title="Continue in a new worktree"
  description="Create a new thread with an excerpt of this thread’s history."
  dismissible={!starting}
>
  <div class="grid min-w-0 gap-4">
    <p class="line-clamp-2 text-base/6 font-medium wrap-anywhere sm:text-sm/6">{thread.title}</p>
    <div class="grid min-w-0 gap-2">
      <p class="text-base/6 font-medium sm:text-sm/6">Start from</p>
      {#if loading}<Skeleton class="h-9 rounded-lg" />
      {:else if refs}
        <div inert={starting || disabled || Boolean(request)}>
          <RefPicker {refs} branch={baseRef} editable onselect={(ref) => (baseRef = ref.name)} />
        </div>
        {#if thread.worktree?.branch && !refs.refs.some((ref) => ref.name === thread.worktree?.branch)}
          <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
            The earlier branch is unavailable. Choose another base branch.
          </p>
        {/if}
      {/if}
    </div>
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      The original thread stays read-only. This does not restore uncommitted files.
    </p>
    {#if error}<Alert tone="error">
        {error}
        {#snippet actions()}
          {#if !refs}<Button size="sm" variant="ghost" disabled={loading || disabled} onclick={load}>Retry</Button>{/if}
        {/snippet}
      </Alert>{/if}
    <DialogActions>
      <Button disabled={starting} onclick={() => (open = false)}>Cancel</Button>
      <Button variant="primary" loading={starting} disabled={loading || disabled || !refs || !baseRef} onclick={start}>
        {request ? "Retry continuation" : "Create worktree"}
      </Button>
    </DialogActions>
  </div>
</Dialog>
