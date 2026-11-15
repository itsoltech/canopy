<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { Timestamp } from "@bufbuild/protobuf/wkt";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { checkLook, unknownPullRequestLook } from "@canopy/domain/github-pr";
  import Button from "#lib/shared/ui/Button.svelte";
  import { formatTime } from "#lib/shared/format.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import PanelRow from "#lib/features/threads/components/PanelRow.svelte";
  import { useWorkspace } from "#lib/features/workspace/workspace.svelte.ts";
  import PullRequestState from "./PullRequestState.svelte";
  import CheckStateIcon from "./CheckStateIcon.svelte";
  import { pullRequestHref } from "./presentation.ts";

  /** One linked pull request: its last known summary, or why its details are missing, with Retry. */
  let {
    threadId,
    link,
    summary,
    pullRequest,
    stale,
    onretry,
  }: {
    threadId: string;
    link: { currentBranch: boolean; detail?: string; stale?: boolean; watchedUntil?: Timestamp | undefined };
    summary: github.PullRequestSummary;
    pullRequest: github.PullRequestRef;
    stale: boolean;
    onretry: () => Promise<void>;
  } = $props();

  const workspace = useWorkspace();
  let retrying = $state(false);
  const known = $derived(summary.state !== "unavailable");
  const detail = $derived(link.detail ?? "");
  const unknown = $derived(unknownPullRequestLook(detail));
  const checks = $derived(checkLook(summary.checksState));
  const name = $derived(`${pullRequest.repositoryName} #${pullRequest.number}`);

  // An agent of this thread hears about these checks (watch_pr_checks).
  const watching = $derived(link.watchedUntil ? `Agent watches checks until ${formatTime(link.watchedUntil)}` : "");

  const retry = async () => {
    retrying = true;

    try {
      await onretry();
    } finally {
      retrying = false;
    }
  };
</script>

<li class="min-w-0 text-sm/5 sm:text-xs/5">
  <PanelRow
    icon="git-fork"
    href={workspace ? undefined : pullRequestHref(threadId, pullRequest.id)}
    onclick={workspace
      ? () =>
          workspace().openModule({
            module: "pull-requests",
            resource: pullRequest.id,
            label: `#${pullRequest.number} · ${summary.title || pullRequest.repositoryName}`,
          })
      : undefined}
    class={link.currentBranch ? "bg-zinc-950/5 dark:bg-white/8" : undefined}
  >
    {#snippet lead()}{#if known}<PullRequestState state={summary.state} iconOnly />{:else}<span
          class="flex shrink-0"
          {@attach tooltip(unknown.label)}><CheckStateIcon look={unknown} /></span
        >{/if}{/snippet}
    {#if known}<span title={summary.title}>{summary.title}</span>{:else}<span
        class="text-zinc-500 dark:text-zinc-400"
        title={name}>{unknown.label}</span
      >{/if}
    {#snippet aside()}{#if watching}<span class="flex shrink-0" {@attach tooltip(watching)}
          ><Icon name="eye" size="sm" label={watching} /></span
        >{/if}<span class="shrink-0 text-zinc-500 tabular-nums">#{pullRequest.number}</span><span
        class="flex size-4 shrink-0"
        {@attach tooltip(known ? `Checks: ${checks.label}` : "")}
        >{#if known}<CheckStateIcon look={checks} label={`Checks: ${checks.label}`} />{/if}</span
      >{/snippet}
  </PanelRow>
  {#if detail}<div class="flex min-w-0 items-start gap-2 px-2 pb-1 text-zinc-500 dark:text-zinc-400">
      <p class="min-w-0 flex-1 break-words">
        {detail}{#if known && summary.verifiedAt}{" "}Last verified {formatTime(summary.verifiedAt)}.{/if}
      </p>
      <Button size="sm" disabled={retrying} onclick={() => void retry()}>Retry</Button>
    </div>{:else if stale && summary.verifiedAt}<p class="px-2 text-zinc-500 dark:text-zinc-400">
      Last verified {formatTime(summary.verifiedAt)}
    </p>{/if}
</li>
