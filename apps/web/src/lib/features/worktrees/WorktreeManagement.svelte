<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { listWorktrees, cleanupWorktrees } from "./api.ts";
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

  let entries = $state<ui.WorktreeEntry[]>([]);
  let loading = $state(true);
  let error = $state("");
  let previewed = $state(false);
  let loaded = $state(false);
  const count = $derived(entries.filter((e) => e.wouldRemove && !e.removed).length);
  const overview = useOverview();

  $effect(() =>
    overview.subscribe((update) => {
      if (
        update.change.case === "linkedReadCompleted" &&
        update.change.value === "ListWorktrees" &&
        !loading &&
        !previewed
      )
        void load();
    }),
  );

  async function load(action: "list" | "preview" | "execute" = "list") {
    loading = true;
    error = "";

    try {
      const response =
        action === "list"
          ? await listWorktrees({ ...scope, worktreeId })
          : await cleanupWorktrees(scope.projectId, scope.workerId, action === "preview");

      entries = response.entries;
      loaded = true;
      previewed = action === "preview";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not load worktrees. Refresh to try again.";
      previewed = false;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void scope;
    void worktreeId;
    void load();
  });
</script>

<section class={["min-w-0", className]} aria-label="Worktrees">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 class="text-lg font-semibold text-balance">{worktreeId ? "Worktree status" : "Worktrees on your computers"}</h2>
    <div class="flex flex-wrap gap-2">
      <Button size="sm" disabled={loading} onclick={() => load()}>Refresh</Button>
      {#if !worktreeId}
        <Button size="sm" loading={loading && loaded} disabled={loading} onclick={() => load("preview")}
          >Preview cleanup</Button
        >
        <Button size="sm" disabled={loading || !previewed || !count} onclick={() => load("execute")}
          >Run cleanup now</Button
        >
      {/if}
    </div>
  </div>
  {#if error}<Alert class="mt-4" tone="error">{error}</Alert>{/if}
  {#if previewed}<p class="mt-4 text-base font-medium sm:text-sm" role="status">
      Cleanup removes {count}
      {count === 1 ? "worktree" : "worktrees"}. Local work that needs confirmation stays.
    </p>{/if}
  {#if loading && !loaded}<Skeleton class="mt-4 h-32 w-full" />
  {:else if !entries.length && !error}<p class="mt-4 text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
      {worktreeId ? "This worktree was removed. Thread history stays available." : "No worktrees in this scope."}
    </p>
  {:else}
    <div class="mt-2 divide-y divide-zinc-950/10 dark:divide-white/10">
      {#each entries as entry (entry.worktree?.id)}<WorktreeCard {entry} onchange={() => load()} />{/each}
    </div>
  {/if}
</section>
