<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { checkLook } from "@canopy/domain/github-pr";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import PullRequestState from "#lib/features/github/PullRequestState.svelte";
  import CheckStateIcon from "#lib/features/github/CheckStateIcon.svelte";

  /**
   * The collapsed thread summary: the branch, the newest pull request with its checks and the number of
   * subagents, so the key context stays visible. Pressing it opens the summary.
   */
  let {
    thread,
    subagents,
    expanded,
    controls,
    onopen,
    pill = $bindable(),
  }: {
    thread: ui.Thread;
    subagents: number;
    expanded: boolean;
    controls?: string | undefined;
    onopen: () => void;
    pill?: HTMLButtonElement | undefined;
  } = $props();

  const head = $derived(thread.worktree ?? thread.checkoutHead);
  const branch = $derived(head ? head.branch || head.detachedCommit : "");
  const pr = $derived(thread.newestPullRequest?.ref ? thread.newestPullRequest : undefined);
  const checks = $derived(pr ? checkLook(pr.checksState) : undefined);
</script>

<button
  bind:this={pill}
  type="button"
  class="flex h-8 max-w-80 min-w-0 items-center gap-1.5 rounded-lg bg-white pr-1.5 pl-2.5 text-sm/5 text-zinc-700 shadow-sm ring-1 ring-zinc-950/10 focus-ring hover:bg-zinc-50 sm:h-7 sm:text-xs/5 dark:bg-zinc-900 dark:text-zinc-300 dark:shadow-none dark:ring-white/10 dark:hover:bg-zinc-800"
  aria-expanded={expanded}
  aria-controls={controls}
  aria-label="Show thread details"
  onclick={onopen}
>
  {#if branch}<Icon name="git-branch" class="shrink-0" /><span class="min-w-0 truncate font-mono">{branch}</span>{/if}
  {#if pr?.ref}
    {#if branch}<span aria-hidden="true" class="text-zinc-400">·</span>{/if}
    <PullRequestState state={pr.state} iconOnly />
    <span class="shrink-0 tabular-nums">#{pr.ref.number}</span>
    {#if checks && pr.checksState}<CheckStateIcon look={checks} label={`Checks: ${checks.label}`} />{/if}
  {/if}
  {#if subagents > 0}
    {#if branch || pr}<span aria-hidden="true" class="text-zinc-400">·</span>{/if}
    <Icon name="sparkles" class="shrink-0" /><span class="shrink-0 tabular-nums">{subagents}</span>
  {/if}
  {#if !branch && !pr && subagents === 0}<span class="shrink-0">Thread details</span>{/if}
  <Icon name="chevron-down" class="shrink-0" />
</button>
