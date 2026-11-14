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
  let offset = $state(0);
  const listId = $props.id();
  let creating = $state(false);
  let error = $state("");
  let previous = $state<{ thread: string; offset: number; value: github.ThreadPullRequestsResponse }>();
  let identity = $state("");

  const read = $derived(
    new SharedRead<github.ThreadPullRequestsResponse>(
      queries,
      `ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}:${offset}`,
      () => api.pullRequests(thread.id, 20, offset),
    ),
  );

  const data = $derived(read.data ?? (previous?.thread === thread.id ? previous.value : undefined));
  const shownOffset = $derived(read.data ? offset : (previous?.offset ?? 0));
  const total = $derived(data?.totalCount ?? thread.pullRequestCount);

  $effect(() => {
    const current = thread.id;

    if (identity !== current) {
      identity = current;
      offset = 0;
      expanded = false;
    }
  });

  $effect(() => {
    if (read.data) previous = { thread: thread.id, offset, value: read.data };
  });

  $effect(() => {
    if (read.data && offset >= read.data.totalCount && offset > 0) offset = 0;
  });

  const collapse = () => {
    expanded = false;
    offset = 0;
  };

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
  <h2
    class="flex items-center justify-between gap-2 px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
  >
    Pull requests <span class="tabular-nums">{total}</span>
  </h2>
  {#snippet rows(items: typeof links)}
    {#each items as link (link.summary?.ref?.id)}
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
  {/snippet}
  <ul role="list" class="grid min-w-0 gap-0.5">
    {@render rows(links.slice(0, 4))}
  </ul>
  <div class="pr-disclosure" data-open={expanded} inert={!expanded} id={listId}>
    <div class="min-h-0 overflow-hidden">
      <ul role="list" class="grid max-h-64 min-w-0 gap-0.5 overflow-y-auto overscroll-contain">
        {@render rows(links.slice(4, 20))}
      </ul>
      {#if total > 20}<div class="flex min-h-9 items-center justify-between gap-2 px-2 text-sm/5 sm:text-xs/5">
          <Button size="sm" disabled={offset === 0 || !read.data} onclick={() => (offset = Math.max(0, offset - 20))}
            >Previous</Button
          >
          <p class="text-zinc-500 tabular-nums dark:text-zinc-400" aria-live="polite">
            {shownOffset + 1}–{Math.min(shownOffset + 20, total)} of {total}
          </p>
          <Button size="sm" disabled={!read.data?.nextOffset} onclick={() => (offset = data?.nextOffset ?? 0)}
            >Next</Button
          >
        </div>{/if}
    </div>
  </div>
  {#if total > 4}<button
      type="button"
      class="min-h-9 w-fit px-2 text-left text-sm/5 text-zinc-500 focus-ring hover:text-zinc-950 sm:text-xs/5 dark:text-zinc-400 dark:hover:text-white"
      aria-expanded={expanded}
      aria-controls={listId}
      onclick={() => (expanded ? collapse() : (expanded = true))}
      >{expanded ? "Show less" : `Show ${total - 4} more`}</button
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
    onlinked={() => {
      collapse();
      void read.reload();
    }}
  />
  {#if !data?.hasCurrentBranch && !links.some((link) => link.currentBranch)}<PanelRow
      icon="git-fork"
      disabled={data?.stale}
      onclick={() => (creating = true)}>Create pull request</PanelRow
    >{/if}
  <CreatePullRequest threadId={thread.id} bind:open={creating} oncreated={() => void read.reload()} />
</section>

<style>
  .pr-disclosure {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--duration-fast) var(--ease-smooth-out);
  }
  .pr-disclosure[data-open="true"] {
    grid-template-rows: 1fr;
  }
  @media (prefers-reduced-motion: reduce) {
    .pr-disclosure {
      transition: none;
    }
  }
</style>
