<script lang="ts">
  import type { ui, github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries, revalidateEvery } from "#lib/shared/queries.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import LinkPullRequest from "./LinkPullRequest.svelte";
  import CreatePullRequest from "./CreatePullRequest.svelte";
  import LinkedPullRequestRow from "./LinkedPullRequestRow.svelte";
  import * as api from "./api.ts";
  import { pullRequestsRefreshing } from "@canopy/domain/github-pr";
  import PanelRow from "#lib/features/threads/components/PanelRow.svelte";

  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  let expanded = $state(false);
  let creating = $state(false);
  let error = $state("");

  const read = $derived(
    new SharedRead<github.ThreadPullRequestsResponse>(
      queries,
      `ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}`,
      () => api.pullRequests(thread.id),
    ),
  );

  const data = $derived(read.data);

  // Re-read soon while the gateway refreshes stale links in the background.
  $effect(() => revalidateEvery(read.key, pullRequestsRefreshing(data) ? 3_000 : 60_000));

  /** The refresh records its reason on the gateway; the list shows it either way. */
  const retry = async (id: string) => {
    await api.pullRequest(id, true).catch(() => {});
    await read.reload().catch(() => {});
  };

  const links = $derived(
    data?.links ??
      (thread.newestPullRequest ? [{ summary: thread.newestPullRequest, source: "", currentBranch: false }] : []),
  );
</script>

<section aria-label="Pull requests" class={["grid min-w-0 gap-0.5 px-1.5 py-1", className]}>
  <h2 class="px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Pull requests</h2>
  <ul role="list" class="grid min-w-0 gap-0.5">
    {#each expanded ? links : links.slice(0, 1) as link (link.summary?.ref?.id)}
      {@const pr = link.summary}
      {#if pr?.ref}<LinkedPullRequestRow
          threadId={thread.id}
          {link}
          summary={pr}
          pullRequest={pr.ref}
          stale={!!data?.stale}
          onretry={() => retry(pr.ref!.id)}
        />{/if}
    {/each}
  </ul>
  {#if links.length > 1}<button
      type="button"
      class="min-h-9 w-fit px-2 text-left text-sm/5 text-zinc-500 focus-ring hover:text-zinc-950 sm:text-xs/5 dark:text-zinc-400 dark:hover:text-white"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}>{expanded ? "Show less" : `Show ${links.length - 1} more`}</button
    >{/if}
  {#if read.snapshot.error || error}<Alert
      >{error || "Could not load pull requests. Check the connection, then retry."}<Button
        size="sm"
        onclick={() => void read.reload().catch(() => {})}>Retry</Button
      ></Alert
    >{/if}
  <LinkPullRequest
    threadId={thread.id}
    revision={data?.revision ?? thread.pullRequestRevision}
    disabled={data?.stale}
    onlinked={(value) => read.set(value)}
  />
  {#if !links.some((link) => link.currentBranch)}<PanelRow
      icon="git-fork"
      disabled={data?.stale}
      onclick={() => (creating = true)}>Create pull request</PanelRow
    >{/if}
  <CreatePullRequest threadId={thread.id} bind:open={creating} oncreated={() => void read.reload()} />
</section>
