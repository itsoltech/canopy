<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { reviewerLook } from "@canopy/domain/github-pr";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import GitHubAvatar from "./GitHubAvatar.svelte";
  import { toneClasses } from "./presentation.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import MetadataEdit from "./MetadataEdit.svelte";
  import ReRequestReview from "./ReRequestReview.svelte";

  let { snapshot, class: className }: { snapshot: github.PullRequestSnapshot; class?: ClassValue } = $props();
  let reviewerDisplay = $state<github.PullRequestMetadata>();
  let assigneeDisplay = $state<github.PullRequestMetadata>();

  const reviewers = $derived(
    reviewerDisplay
      ? reviewerDisplay.reviewers.map((r) => ({ login: r.name, state: "requested", nodeId: r.id }))
      : snapshot.reviewers,
  );

  const assignees = $derived(assigneeDisplay ? assigneeDisplay.assignees.map((a) => a.name) : snapshot.assignees);
</script>

<div class={["grid gap-3 text-sm/5 sm:text-xs/5", className]}>
  <section aria-label="Reviewers" class="relative grid gap-1">
    <h3 class="font-medium text-zinc-500 dark:text-zinc-400">Reviewers</h3>
    <MetadataEdit
      {snapshot}
      kind="reviewers"
      ondisplay={(value) => (reviewerDisplay = value)}
      class="absolute -top-1 right-0"
    />
    {#if !reviewers.length}<p class="text-zinc-500 dark:text-zinc-400">No reviewers requested</p>{/if}
    {#each reviewers as reviewer, i (`${reviewer.login}:${i}`)}
      {@const look = reviewerLook(reviewer.state)}
      <div class="flex min-h-8 min-w-0 items-center gap-2">
        {#if reviewer.login.includes("/")}<Icon name="user-group" label="Team" />{:else}<GitHubAvatar
            userId=""
            login={reviewer.login}
            compact
          />{/if}
        <p class="min-w-0 flex-1 truncate" title={reviewer.login}>{reviewer.login}</p>
        <div {@attach tooltip(look.label)} class={["flex shrink-0 items-center gap-1.5", toneClasses[look.tone]]}>
          <Icon name={look.icon} label={look.label} tone="inherit" />
        </div>
        {#if reviewer.nodeId && reviewer.state !== "requested"}<ReRequestReview {snapshot} id={reviewer.nodeId} />{/if}
      </div>
    {/each}
  </section>
  <section aria-label="Assignees" class="relative grid gap-1">
    <h3 class="font-medium text-zinc-500 dark:text-zinc-400">Assignees</h3>
    <MetadataEdit
      {snapshot}
      kind="assignees"
      ondisplay={(value) => (assigneeDisplay = value)}
      class="absolute -top-1 right-0"
    />
    {#if !assignees.length}<p class="text-zinc-500 dark:text-zinc-400">No assignees</p>{/if}
    {#each assignees as login, i (`${login}:${i}`)}<div class="flex min-h-8 min-w-0 items-center gap-2">
        <GitHubAvatar userId="" {login} compact />
        <p class="min-w-0 flex-1 truncate" title={login}>{login}</p>
        <span {@attach tooltip("Assigned")}><Icon name="user" label="Assigned" /></span>
      </div>{/each}
  </section>
</div>
