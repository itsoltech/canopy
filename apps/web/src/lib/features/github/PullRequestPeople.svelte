<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { reviewerLook } from "@canopy/domain/github-pr";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import GitHubAvatar from "./GitHubAvatar.svelte";
  import { toneClasses } from "./presentation.ts";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
</script>

<div class={["grid gap-3 text-sm/5 sm:text-xs/5", className]}>
  <section aria-label="Reviewers" class="grid gap-1">
    <h3 class="font-medium text-zinc-500 dark:text-zinc-400">Reviewers</h3>
    {#if !snapshot.reviewers.length}<p class="text-zinc-500 dark:text-zinc-400">No reviewers requested</p>{/if}
    {#each snapshot.reviewers as reviewer, i (`${reviewer.login}:${i}`)}
      {@const look = reviewerLook(reviewer.state)}
      <div class="flex min-h-8 min-w-0 items-center gap-2">
        <GitHubAvatar userId="" login={reviewer.login} compact />
        <p class="min-w-0 flex-1 truncate" title={reviewer.login}>{reviewer.login}</p>
        <div class={["flex shrink-0 items-center gap-1.5", toneClasses[look.tone]]}>
          <Icon name={look.icon} tone="inherit" /><span>{look.label}</span>
        </div>
      </div>
    {/each}
  </section>
  {#if snapshot.assignees.length}<section aria-label="Assignees" class="grid gap-1">
      <h3 class="font-medium text-zinc-500 dark:text-zinc-400">Assignees</h3>
      {#each snapshot.assignees as login, i (`${login}:${i}`)}<div class="flex min-h-8 min-w-0 items-center gap-2">
          <GitHubAvatar userId="" {login} compact />
          <p class="min-w-0 flex-1 truncate" title={login}>{login}</p>
          <Icon name="user" />
        </div>{/each}
    </section>{/if}
</div>
