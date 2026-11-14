<script lang="ts">
  import type { ui, github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { SharedRead, queries, revalidateEvery } from "#lib/shared/queries.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import { formatTime } from "#lib/shared/format.ts";
  import LinkPullRequest from "./LinkPullRequest.svelte";
  import CreatePullRequest from "./CreatePullRequest.svelte";
  import PullRequestState from "./PullRequestState.svelte";
  import * as api from "./api.ts";
  import PanelRow from "#lib/features/threads/components/PanelRow.svelte";
  import CheckStateIcon from "./CheckStateIcon.svelte";
  import { checkLook } from "@canopy/domain/github-pr";
  import { pullRequestHref } from "./presentation.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { useWorkspace } from "#lib/features/workspace/workspace.svelte.ts";

  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  let expanded = $state(false);
  let creating = $state(false);
  let error = $state("");
  const workspace = useWorkspace();

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

<section aria-label="Pull requests" class={["grid min-w-0 gap-0.5 px-1.5 py-1", className]}>
  <h2 class="px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Pull requests</h2>
  <ul role="list" class="grid min-w-0 gap-0.5">
    {#each expanded ? links : links.slice(0, 1) as link (link.summary?.ref?.id)}
      {@const pr = link.summary}
      {#if pr?.ref}
        {@const checks = checkLook(pr.checksState)}
        <li class="min-w-0 text-sm/5 sm:text-xs/5">
          <PanelRow
            icon="git-fork"
            href={workspace ? undefined : pullRequestHref(thread.id, pr.ref.id)}
            onclick={workspace
              ? () =>
                  workspace().openModule({
                    module: "pull-requests",
                    resource: pr.ref!.id,
                    label: `#${pr.ref!.number} · ${pr.title || pr.ref!.repositoryName}`,
                  })
              : undefined}
            class={link.currentBranch ? "bg-zinc-950/5 dark:bg-white/8" : undefined}
          >
            {#snippet lead()}<PullRequestState state={pr.state} iconOnly />{/snippet}
            <span title={pr.title}>{pr.title || pr.ref.repositoryName}</span>
            {#snippet aside()}<span class="shrink-0 text-zinc-500 tabular-nums">#{pr.ref!.number}</span><span
                {@attach tooltip(`Checks: ${checks.label}`)}
                ><CheckStateIcon look={checks} label={`Checks: ${checks.label}`} /></span
              >{/snippet}
          </PanelRow>
          {#if data?.stale && pr.verifiedAt}<p class="text-zinc-500 dark:text-zinc-400">
              Last verified {formatTime(pr.verifiedAt)}
            </p>{/if}
        </li>
      {/if}
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
