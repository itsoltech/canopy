<script lang="ts">
  import type { ui, github } from "@canopy/contracts";
  import { tick } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import LinkPullRequest from "./LinkPullRequest.svelte";
  import CreatePullRequest from "./CreatePullRequest.svelte";
  import LinkedPullRequestRow from "./LinkedPullRequestRow.svelte";
  import * as api from "./api.ts";
  import PanelRow from "#lib/features/threads/components/PanelRow.svelte";

  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  let expanded = $state(false);
  let offset = $state(0);
  const listId = $props.id();
  let creating = $state(false);
  let unlinking = $state(false);
  let error = $state("");
  let heading = $state<HTMLHeadingElement>();
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
      error = "";
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

  async function refresh(id: string) {
    const threadId = thread.id;
    const snapshot = await api.pullRequest(id, true).catch(() => undefined);

    if (threadId === thread.id) await read.reload().catch(() => {});

    return !!snapshot && !snapshot.stale;
  }

  async function unlink(pullRequestId: string, row: HTMLLIElement | undefined) {
    if (unlinking || data?.stale) return;
    const threadId = thread.id;
    const revision = data?.revision ?? thread.pullRequestRevision;
    unlinking = true;
    error = "";

    try {
      const updated = await api.unlink(threadId, pullRequestId, revision);

      if (threadId !== thread.id) return;
      const hadFocus = row?.contains(document.activeElement);
      // The mutation returns page one. Apply it without waiting for the overview event.
      offset = 0;

      if (updated.revision >= (read.data?.revision ?? thread.pullRequestRevision)) read.set(updated);

      if (hadFocus) {
        await tick();

        if (document.activeElement === document.body) heading?.focus({ preventScroll: true });
      }
    } catch {
      if (threadId === thread.id) error = "Could not unlink this pull request. Refresh the list, then try again.";
    } finally {
      unlinking = false;
    }
  }

  const links = $derived(
    data?.links ??
      (thread.newestPullRequest ? [{ summary: thread.newestPullRequest, source: "", currentBranch: false }] : []),
  );
</script>

<section aria-label="Pull requests" class={["grid min-w-0 gap-0.5 px-1.5 py-1", className]}>
  <h2
    bind:this={heading}
    tabindex="-1"
    class="flex items-center justify-between gap-2 px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
  >
    Pull requests <span class="tabular-nums">{total}</span>
  </h2>
  {#snippet rows(items: typeof links)}
    {#each items as link (link.summary?.ref?.id)}
      {@const pr = link.summary}
      {@const ref = pr?.ref}
      {#if pr && ref}<LinkedPullRequestRow
          threadId={thread.id}
          {link}
          summary={pr}
          pullRequest={ref}
          stale={!!data?.stale}
          onrefresh={() => refresh(ref.id)}
          unlinkDisabled={unlinking || !!data?.stale}
          onunlink={(row) => void unlink(ref.id, row)}
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
  {#if read.snapshot.error || error}<Alert tone="error"
      >{error || "Could not load pull requests. Check the connection, then retry."}<Button
        size="sm"
        onclick={() => {
          heading?.focus({ preventScroll: true });
          error = "";
          void read.reload().catch(() => {});
        }}>{error ? "Refresh list" : "Retry"}</Button
      ></Alert
    >{/if}
  <LinkPullRequest
    threadId={thread.id}
    revision={data?.revision ?? thread.pullRequestRevision}
    disabled={unlinking || !!data?.stale}
    onlinked={() => {
      collapse();
      void read.reload();
    }}
  />
  {#if !data?.hasCurrentBranch && !links.some((link) => link.currentBranch)}<PanelRow
      icon="git-fork"
      disabled={unlinking || !!data?.stale}
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
