<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { HttpError } from "#lib/shared/http.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { cleanUpFailedWorktree, listWorktrees, cleanupWorktrees } from "./api.ts";
  import WorktreeCard from "./WorktreeCard.svelte";
  import type { WorktreeScope } from "./worktree-settings.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";

  let {
    scope = { projectId: "", workerId: "" },
    worktreeId = "",
    class: className,
  }: {
    scope?: WorktreeScope;
    worktreeId?: string;
    class?: ClassValue;
  } = $props();

  let entries = $state.raw<ui.WorktreeEntry[]>([]);
  let loading = $state(true);
  let error = $state("");
  let previewed = $state(false);
  let loadedScope = $state("");
  let request = 0;
  const scopeKey = $derived(JSON.stringify([scope.projectId, scope.workerId, worktreeId]));
  const loaded = $derived(loadedScope === scopeKey);
  const count = $derived(entries.filter((e) => e.wouldRemove && !e.removed).length);
  const overview = useOverview();

  let cleanupOpen = $state(false);
  let cleanupTarget = $state.raw<{ id: string; token: string; path: string }>();
  let cleaning = $state(false);
  let failed = $state.raw<{ id: string; reason: string }>();

  const currentTarget = $derived(entries.find((entry) => entry.worktree?.id === cleanupTarget?.id));

  const targetIsCurrent = $derived(
    loaded &&
      currentTarget?.worktree?.locked &&
      currentTarget.worktree.external &&
      currentTarget.failedCleanupToken === cleanupTarget?.token &&
      currentTarget.online &&
      overview.worker(currentTarget.worktree.workerId)?.online &&
      !currentTarget.removed &&
      !currentTarget.busy,
  );

  const cleanupError = $derived(failed?.id === cleanupTarget?.id ? failed?.reason : undefined);

  $effect(() =>
    overview.subscribe((update) => {
      if (
        update.change.case === "linkedReadCompleted" &&
        update.change.value === "ListWorktrees" &&
        !loading &&
        !cleaning &&
        !previewed
      )
        void load();
    }),
  );

  async function load(action: "list" | "preview" | "execute" = "list") {
    const key = scopeKey;
    const id = ++request;
    loading = true;
    error = "";

    try {
      const response =
        action === "list"
          ? await listWorktrees({ ...scope, worktreeId })
          : await cleanupWorktrees(scope.projectId, scope.workerId, action === "preview");

      if (id !== request || key !== scopeKey) return;
      entries = response.entries;
      loadedScope = key;
      failed = undefined;
      previewed = action === "preview";
    } catch (cause) {
      if (id !== request || key !== scopeKey) return;
      error = cause instanceof Error ? cause.message : "Could not load worktrees. Refresh to try again.";
      previewed = false;
    } finally {
      if (id === request && key === scopeKey) loading = false;
    }
  }

  function reviewCleanup(entry: ui.WorktreeEntry) {
    if (!entry.worktree || !entry.failedCleanupToken || !loaded || loading || cleaning) return;
    cleanupTarget = { id: entry.worktree.id, token: entry.failedCleanupToken, path: entry.worktree.path };
    cleanupOpen = true;
  }

  async function executeCleanup() {
    const target = cleanupTarget;
    const key = scopeKey;

    if (!target || !targetIsCurrent || loading || cleaning || cleanupError || error) return;
    cleaning = true;

    try {
      await cleanUpFailedWorktree(target.id, target.token);

      if (key !== scopeKey) return;

      cleanupOpen = false;
      await load();
    } catch (cause) {
      if (key === scopeKey)
        failed = {
          id: target.id,
          reason: (cause instanceof HttpError && cause.message) || "Could not clean up the worktree.",
        };
    } finally {
      cleaning = false;
    }
  }

  $effect(() => {
    void scopeKey;
    cleanupOpen = false;
    previewed = false;
    untrack(() => void load());
  });
</script>

<section class={["min-w-0", className]} aria-label="Worktrees">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 class="text-lg font-semibold text-balance">{worktreeId ? "Worktree status" : "Worktrees on your computers"}</h2>
    <div class="flex flex-wrap gap-2">
      <Button size="sm" disabled={loading || cleaning} onclick={() => load()}>Refresh</Button>
      {#if !worktreeId}
        <Button size="sm" loading={loading && loaded} disabled={loading || cleaning} onclick={() => load("preview")}
          >Preview cleanup</Button
        >
        <Button size="sm" disabled={loading || cleaning || !previewed || !count} onclick={() => load("execute")}
          >Run cleanup now</Button
        >
      {/if}
    </div>
  </div>
  {#if error}<Alert class="mt-4" tone="error">{error}</Alert>{/if}
  {#if previewed}<p class="mt-4 text-base font-medium sm:text-sm" role="status">
      Cleanup removes {count}
      {count === 1 ? "worktree" : "worktrees"}. Archived and deleted thread rules can discard local files.
    </p>{/if}
  {#if loading && !loaded}<Skeleton class="mt-4 h-32 w-full" />
  {:else if loaded && !entries.length && !error}<p class="mt-4 text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
      {worktreeId ? "This worktree was removed. Thread history stays available." : "No worktrees in this scope."}
    </p>
  {:else if loaded}
    <div class="mt-2 divide-y divide-zinc-950/10 dark:divide-white/10">
      {#each entries as entry (entry.worktree?.id)}
        <WorktreeCard
          {entry}
          onchange={() => load()}
          oncleanup={worktreeId ? undefined : reviewCleanup}
          cleanupDisabled={loading || cleaning || Boolean(error)}
        />
      {/each}
    </div>
  {/if}
</section>

<Dialog
  bind:open={cleanupOpen}
  title="Clean up worktree?"
  description="Canopy deletes the folder and removes the worktree from Git. The local branch stays. You can’t undo this."
  dismissible={!cleaning}
>
  <div class="grid gap-4">
    <code class="text-base wrap-anywhere sm:text-sm">{cleanupTarget?.path}</code>
    {#if cleanupError}<Alert tone="error">{cleanupError}</Alert>
    {:else if !targetIsCurrent && !loading && !cleaning}
      <Alert tone="warning">This worktree is no longer ready for cleanup.</Alert>
    {/if}
    <DialogActions>
      <Button data-autofocus disabled={cleaning} onclick={() => (cleanupOpen = false)}>Cancel</Button>
      {#if cleanupError || (!targetIsCurrent && !loading && !cleaning) || error}
        <Button
          class="sm:min-w-40"
          disabled={loading}
          onclick={() => {
            cleanupOpen = false;
            void load();
          }}>Refresh status</Button
        >
      {:else}
        <Button
          class="sm:min-w-40"
          variant="danger"
          loading={cleaning}
          disabled={loading || !targetIsCurrent}
          onclick={executeCleanup}
        >
          Clean up worktree
        </Button>
      {/if}
    </DialogActions>
  </div>
</Dialog>
