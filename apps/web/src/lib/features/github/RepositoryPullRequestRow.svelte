<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatRelative } from "#lib/shared/format.ts";
  import PullRequestState from "./PullRequestState.svelte";

  let { pr, class: className }: { pr: github.RepositoryPullRequest; class?: ClassValue } = $props();
</script>

<div class={["flex min-w-0 items-start gap-2", className]}>
  <div class="flex h-5 shrink-0 items-center"><PullRequestState state={pr.state} iconOnly /></div>
  <div class="grid min-w-0 flex-1 gap-0.5">
    <div class="flex min-w-0 items-baseline gap-1.5 text-base/5 sm:text-sm/5">
      <span class="shrink-0 text-zinc-500 tabular-nums">#{pr.number}</span>
      <span class="min-w-0 truncate font-medium" title={pr.title}>{pr.title}</span>
    </div>
    <p class="truncate text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400" title={`${pr.headRef} → ${pr.baseRef}`}>
      {pr.headRef} → {pr.baseRef}
    </p>
    <div class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
      <span class="min-w-0 truncate" title={pr.author}>{pr.author}</span>
      {#if pr.updatedAt}<span class="shrink-0 tabular-nums">{formatRelative(pr.updatedAt)}</span>{/if}
    </div>
  </div>
  <div class="grid w-20 shrink-0 gap-0.5 text-right text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
    {#if pr.currentBranch}<span>Current branch</span>{:else if pr.viewerIsAuthor}<span>Yours</span>{/if}
    {#if pr.linked}<span>Linked</span>{/if}
  </div>
</div>
