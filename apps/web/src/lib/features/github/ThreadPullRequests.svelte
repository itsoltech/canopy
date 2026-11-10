<script lang="ts">
  import type { ui, github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries } from "#lib/shared/queries.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";
  import { formatTime } from "#lib/shared/format.ts";
  import LinkPullRequest from "./LinkPullRequest.svelte";
  import PullRequestState from "./PullRequestState.svelte";
  import * as api from "./api.ts";

  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  let expanded = $state(false);
  let linking = $state(false);
  let error = $state("");

  const read = $derived(
    new SharedRead<github.ThreadPullRequestsResponse>(
      queries,
      `ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}`,
      () => api.pullRequests(thread.id),
    ),
  );

  const data = $derived(read.data);
  const links = $derived(data?.links ?? (thread.newestPullRequest ? [{ summary: thread.newestPullRequest }] : []));

  async function unlink(id: string) {
    error = "";

    try {
      read.set(await api.unlink(thread.id, id, data?.revision ?? thread.pullRequestRevision));
    } catch {
      error = "Could not unlink this pull request. Refresh, then retry.";
    }
  }
</script>

<section aria-label="Pull requests" class={["grid min-w-0 gap-2 px-3 py-2", className]}>
  <h2 class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Pull requests</h2>
  {#if !links.length}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">No pull requests yet</p>{/if}
  <ul role="list" class="grid min-w-0 gap-2">
    {#each expanded ? links : links.slice(0, 1) as link (link.summary?.ref?.id)}
      {@const pr = link.summary}
      {#if pr?.ref}
        <li class="grid min-w-0 gap-1 text-sm/5 sm:text-xs/5">
          <a
            href="/pull-requests/{pr.ref.id}?thread={encodeURIComponent(thread.id)}"
            class="rounded-md font-medium break-words text-zinc-900 focus-ring hover:underline dark:text-zinc-100"
            >{pr.title || `${pr.ref.repositoryName} #${pr.ref.number}`}</a
          >
          <div class="flex flex-wrap items-center gap-2 text-zinc-500 dark:text-zinc-400">
            <span class="min-w-0 break-all">{pr.ref.repositoryName} #{pr.ref.number}</span><PullRequestState
              state={pr.state}
            />
          </div>
          <div class="flex items-center justify-between gap-2 text-zinc-500 dark:text-zinc-400">
            <span>Checks: {pr.checksState || "unavailable"} · {pr.checksCount}</span><Button
              size="sm"
              disabled={data?.stale}
              onclick={() => unlink(pr.ref!.id)}>Unlink</Button
            >
          </div>
          {#if data?.stale && pr.verifiedAt}<p class="text-zinc-500 dark:text-zinc-400">
              Last verified {formatTime(pr.verifiedAt)}
            </p>{/if}
        </li>
      {/if}
    {/each}
  </ul>
  {#if links.length > 1}<Button size="sm" aria-expanded={expanded} onclick={() => (expanded = !expanded)}
      >{expanded ? "Show less" : `Show ${links.length - 1} more`}</Button
    >{/if}
  {#if data?.detail}<p role="status" class="text-sm/5 text-zinc-500 dark:text-zinc-400">{data.detail}</p>{/if}
  {#if read.snapshot.error || error}<Alert
      >{error || "Could not load pull requests. Check the connection, then retry."}<Button
        size="sm"
        onclick={() => void read.reload().catch(() => {})}>Retry</Button
      ></Alert
    >{/if}
  <Button size="sm" aria-expanded={linking} disabled={data?.stale} onclick={() => (linking = !linking)}
    >{linking ? "Cancel" : "Link pull request"}</Button
  >
  {#if linking}<div transition:expand>
      <LinkPullRequest
        threadId={thread.id}
        revision={data?.revision ?? thread.pullRequestRevision}
        onlinked={(value) => {
          read.set(value);
          linking = false;
        }}
      />
    </div>{/if}
</section>
