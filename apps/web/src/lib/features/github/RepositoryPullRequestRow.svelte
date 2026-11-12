<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatAge } from "@canopy/domain/format";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import PullRequestState from "./PullRequestState.svelte";

  let { pr, class: className }: { pr: github.RepositoryPullRequest; class?: ClassValue } = $props();
</script>

<div class={["flex min-w-0 items-start gap-2", className]}>
  <div class="flex h-5 shrink-0 items-center"><PullRequestState state={pr.state} iconOnly /></div>
  <div class="grid min-w-0 flex-1">
    <div class="flex min-w-0 items-baseline gap-1.5 text-base/5 sm:text-sm/5">
      <span class="shrink-0 text-zinc-500 tabular-nums">#{pr.number}</span>
      <span class="min-w-0 truncate font-medium" title={pr.title}>{pr.title}</span>
      <span class="ml-auto flex w-9 shrink-0 items-center justify-end gap-1 text-zinc-500 dark:text-zinc-400">
        {#if pr.currentBranch}<span aria-label="Current branch" {@attach tooltip("Current branch")}>
            <Icon name="git-branch" />
          </span>{:else if pr.viewerIsAuthor}<span aria-label="Yours" {@attach tooltip("Yours")}>
            <Icon name="user" />
          </span>{/if}
        {#if pr.linked}<span aria-label="Linked" {@attach tooltip("Linked")}><Icon name="check" /></span>{/if}
      </span>
    </div>
    <div class="flex min-w-0 items-center gap-1 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
      <span class="min-w-0 truncate" title={`${pr.headRef} → ${pr.baseRef}`}>{pr.headRef} → {pr.baseRef}</span>
      <span aria-hidden="true">·</span>
      <span class="max-w-24 min-w-0 shrink-0 truncate" title={pr.author}>{pr.author}</span>
      {#if pr.updatedAt}<span class="shrink-0 tabular-nums">· {formatAge(pr.updatedAt)}</span>{/if}
    </div>
  </div>
</div>
