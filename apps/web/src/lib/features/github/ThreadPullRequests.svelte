<script lang="ts">
  import type { ui, github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries, revalidateEvery } from "#lib/shared/queries.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { expand } from "#lib/shared/ui/motion.ts";
  import { formatTime } from "#lib/shared/format.ts";
  import LinkPullRequest from "./LinkPullRequest.svelte";
  import PullRequestState from "./PullRequestState.svelte";
  import * as api from "./api.ts";
  import PanelRow from "#lib/features/threads/components/PanelRow.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { checkLook } from "@canopy/domain/github-pr";
  import { pullRequestHref, toneClasses } from "./presentation.ts";

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

  $effect(() => revalidateEvery(read.key, 60_000));

  const links = $derived(
    data?.links ??
      (thread.newestPullRequest ? [{ summary: thread.newestPullRequest, source: "", currentBranch: false }] : []),
  );
</script>

<section aria-label="Pull requests" class={["grid min-w-0 gap-2 px-3 py-2", className]}>
  <h2 class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Pull requests</h2>
  {#if !links.length}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">No pull requests yet</p>{/if}
  <ul role="list" class="grid min-w-0 gap-2">
    {#each expanded ? links : links.slice(0, 1) as link (link.summary?.ref?.id)}
      {@const pr = link.summary}
      {#if pr?.ref}
        <li class="min-w-0 text-sm/5 sm:text-xs/5">
          <PanelRow
            icon="git-fork"
            href={pullRequestHref(thread.id, pr.ref.id)}
            class={link.currentBranch ? "bg-zinc-950/5 dark:bg-white/8" : undefined}
          >
            {#snippet lead()}<PullRequestState state={pr.state} iconOnly />{/snippet}
            <span title={pr.title}>{pr.title || pr.ref.repositoryName}</span>
            {#snippet aside()}<span class="shrink-0 text-zinc-500 tabular-nums">#{pr.ref!.number}</span><Icon
                name={checkLook(pr.checksState).icon}
                class={toneClasses[checkLook(pr.checksState).tone]}
                label={`Checks: ${checkLook(pr.checksState).label}`}
              />{/snippet}
          </PanelRow>
          <div
            class="flex min-h-5 flex-wrap items-center gap-1.5 px-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
          >
            {#if link.source}<Badge compact>{link.source === "auto" ? "Auto" : "Manual"}</Badge>{/if}
            <span>{link.currentBranch ? "Current branch" : "History"}</span>
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
