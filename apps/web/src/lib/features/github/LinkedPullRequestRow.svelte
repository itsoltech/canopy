<script lang="ts">
  import type { github } from "@canopy/contracts";
  import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
  import { createAttachmentKey } from "svelte/attachments";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { checkLook, unknownPullRequestLook } from "@canopy/domain/github-pr";
  import Button from "#lib/shared/ui/Button.svelte";
  import { formatTime } from "#lib/shared/format.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import { longPress } from "#lib/shared/ui/long-press.ts";
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
    onrefresh,
    unlinkDisabled,
    onunlink,
  }: {
    threadId: string;
    link: { currentBranch: boolean; detail?: string; stale?: boolean; watchedUntil?: Timestamp | undefined };
    summary: github.PullRequestSummary;
    pullRequest: github.PullRequestRef;
    stale: boolean;
    onrefresh: () => Promise<boolean>;
    unlinkDisabled: boolean;
    onunlink: (row: HTMLLIElement | undefined) => void;
  } = $props();

  const workspace = useWorkspace();
  let row = $state<HTMLLIElement>();
  let refreshing = $state(false);
  let failedAt = $state<number>();
  let menuOpen = $state(false);
  const pressKey = createAttachmentKey();
  const press = longPress(() => (menuOpen = true));
  const known = $derived(summary.state !== "unavailable");
  const verifiedAt = $derived(summary.verifiedAt ? timestampMs(summary.verifiedAt) : 0);
  const detail = $derived(link.detail || (failedAt === verifiedAt ? "Could not refresh status." : ""));
  const unknown = $derived(unknownPullRequestLook(link.detail ?? ""));
  const checks = $derived(checkLook(summary.checksState));
  const checkLabel = $derived(refreshing ? "Refreshing status…" : `Checks: ${checks.label}`);
  const name = $derived(`${pullRequest.repositoryName} #${pullRequest.number}`);
  const url = $derived(`https://github.com/${pullRequest.repositoryName}/pull/${pullRequest.number}`);

  // An agent of this thread hears about these checks (watch_pr_checks).
  const watching = $derived(link.watchedUntil ? `Agent watches checks until ${formatTime(link.watchedUntil)}` : "");

  function context(event: MouseEvent | KeyboardEvent) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    menuOpen = true;
  }

  async function refresh() {
    if (stale || refreshing) return;
    const lastVerified = verifiedAt;
    refreshing = true;

    try {
      failedAt = (await onrefresh()) ? undefined : lastVerified;
    } finally {
      refreshing = false;
    }
  }
</script>

<li bind:this={row} class="min-w-0 text-sm/5 sm:text-xs/5">
  <DropdownMenu bind:open={menuOpen} label="Actions for {name}" sheet>
    {#snippet trigger(menu)}
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
        menuTrigger={{
          ...anchorOnly(menu),
          [pressKey]: press,
          "aria-haspopup": menu["aria-haspopup"],
          "aria-expanded": menuOpen,
          "aria-controls": menuOpen ? menu["aria-controls"] : undefined,
          oncontextmenu: context,
          onkeydown: (event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) context(event);
          },
        }}
        class={["[-webkit-touch-callout:none]", (link.currentBranch || menuOpen) && "bg-zinc-950/5 dark:bg-white/8"]}
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
            {@attach tooltip(known || refreshing ? checkLabel : "")}
            >{#if known || refreshing}<CheckStateIcon
                look={refreshing ? { ...checks, spinning: true } : checks}
                label={checkLabel}
              />{/if}</span
          >{/snippet}
      </PanelRow>
    {/snippet}
    <MenuItem icon="arrow-top-right-on-square" onselect={() => window.open(url, "_blank", "noopener,noreferrer")}
      >Open on GitHub</MenuItem
    >
    <MenuItem icon="arrow-path" disabled={stale || refreshing} onselect={() => void refresh()}>Refresh status</MenuItem>
    <MenuSeparator />
    <MenuItem icon="x-mark" disabled={unlinkDisabled} onselect={() => onunlink(row)}>Unlink from thread</MenuItem>
  </DropdownMenu>
  {#if detail}<div class="flex min-w-0 items-start gap-2 px-2 pb-1 text-zinc-500 dark:text-zinc-400">
      <p class="min-w-0 flex-1 break-words">
        {detail}{#if known && summary.verifiedAt}{" "}Last verified {formatTime(summary.verifiedAt)}.{/if}
      </p>
      <Button size="sm" disabled={stale || refreshing} onclick={() => void refresh()}>Retry</Button>
    </div>{:else if stale && summary.verifiedAt}<p class="px-2 text-zinc-500 dark:text-zinc-400">
      Last verified {formatTime(summary.verifiedAt)}
    </p>{/if}
</li>
