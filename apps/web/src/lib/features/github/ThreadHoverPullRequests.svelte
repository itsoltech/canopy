<script lang="ts">
  import type { github, ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { checkLook, pullRequestsRefreshing, unknownPullRequestLook } from "@canopy/domain/github-pr";
  import { formatCount } from "#lib/shared/format.ts";
  import { SharedRead, queries, revalidateEvery } from "#lib/shared/queries.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import CheckStateIcon from "./CheckStateIcon.svelte";
  import PullRequestState from "./PullRequestState.svelte";
  import { pullRequestHref } from "./presentation.ts";
  import * as api from "./api.ts";

  /** Mounted only while the thread hover card is open; shares the first page with the details panel. */
  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();
  let previous = $state<{ thread: string; value: github.ThreadPullRequestsResponse }>();

  const read = $derived(
    new SharedRead<github.ThreadPullRequestsResponse>(
      queries,
      `ListThreadPullRequests:${thread.id}:${thread.pullRequestRevision}:0`,
      () => api.pullRequests(thread.id),
    ),
  );

  const data = $derived(read.data ?? (previous?.thread === thread.id ? previous.value : undefined));

  const links = $derived(data?.links ?? (thread.newestPullRequest ? [{ summary: thread.newestPullRequest }] : []));

  const total = $derived(data?.totalCount ?? Math.max(thread.pullRequestCount, thread.newestPullRequest ? 1 : 0));

  $effect(() => {
    if (read.data) previous = { thread: thread.id, value: read.data };
  });

  $effect(() => revalidateEvery(read.key, pullRequestsRefreshing(data) ? 3_000 : 60_000));
</script>

<section
  aria-label="Pull requests"
  aria-busy={read.snapshot.loading}
  class={["grid min-w-0 gap-1 text-base/5 sm:text-sm/5", className]}
>
  <h2 class="flex items-center justify-between gap-2 pb-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    Pull requests <span class="tabular-nums">{formatCount(total)}</span>
  </h2>
  <ul role="list" class="grid max-h-64 min-w-0 scroll-py-1 overflow-y-auto overscroll-contain py-1">
    {#each links as link (link.summary?.ref?.id)}
      {@const summary = link.summary}
      {@const ref = summary?.ref}
      {#if summary && ref}
        {@const known = summary.state !== "unavailable"}
        {@const unknown = unknownPullRequestLook("detail" in link ? link.detail : "")}
        {@const checks = checkLook(summary.checksState)}
        <li class="min-w-0">
          <a
            href={pullRequestHref(thread.id, ref.id)}
            class="flex min-h-10 min-w-0 items-center gap-2 rounded-md px-2 text-zinc-700 focus-ring -outline-offset-2 hover:bg-zinc-950/4 sm:min-h-7 dark:text-zinc-300 dark:hover:bg-white/5 pointer-coarse:min-h-11"
          >
            {#if known}<PullRequestState state={summary.state} iconOnly />{:else}<CheckStateIcon look={unknown} />{/if}
            <span class="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400">#{ref.number}</span>
            <TruncatedText
              text={known ? summary.title || ref.repositoryName : unknown.label}
              hint={ref.repositoryName}
              class="flex-1"
            />
            <span
              class="grid size-4 shrink-0 place-items-center"
              {@attach tooltip(known ? `Checks: ${checks.label}` : "")}
            >
              {#if known && (summary.checksCount || summary.checksState)}
                <CheckStateIcon look={checks} label={`Checks: ${checks.label}`} />
              {/if}
            </span>
          </a>
        </li>
      {/if}
    {/each}
  </ul>
  {#if read.snapshot.error}
    <div class="flex flex-wrap items-center justify-between gap-2" role="status">
      <p>Could not load pull requests.</p>
      <Button onclick={() => void read.reload().catch(() => {})}>Retry</Button>
    </div>
  {:else if !data}
    <p role="status">Loading pull requests…</p>
  {/if}
  {#if data && total > links.length}
    <p class="pt-1 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">
      +{formatCount(total - links.length)} more
    </p>
  {/if}
</section>
