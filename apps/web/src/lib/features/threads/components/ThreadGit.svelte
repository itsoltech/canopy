<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { REMOTE_GIT_STATUS } from "@canopy/domain/computers";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { observeActivity } from "#lib/shared/activity.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonGroup from "#lib/shared/ui/ButtonGroup.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { useThreadGit } from "../thread-git.svelte.ts";
  import { pullBusyReason } from "../git-status.ts";

  let { thread, worker, class: className }: { thread: ui.Thread; worker?: ui.Worker; class?: ClassValue } = $props();
  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const home = $derived(overview.computer(thread.nodeId));

  const unavailable = $derived(
    (thread.nodeId && awayReason(home)) ||
      (!worker?.online && "Reconnect this computer to check local changes.") ||
      (capabilities?.methods &&
        !capabilities.methods.includes("GetThreadGitStatus") &&
        "Update Canopy to check local changes.") ||
      (thread.nodeId &&
        !home?.capabilities.includes(REMOTE_GIT_STATUS) &&
        "Update the home computer to check local changes.") ||
      (!worker?.gitStatus && "Update this computer to check local changes.") ||
      "",
  );

  const git = useThreadGit(
    () => thread,
    () => !unavailable,
  );

  const status = $derived(git.data?.status);

  const disabledReason = $derived(
    unavailable ||
      pullBusyReason(thread) ||
      git.data?.detail ||
      status?.pullDisabledReason ||
      (capabilities?.methods && !capabilities.methods.includes("PullThreadOrigin")
        ? "Update Canopy to pull changes."
        : ""),
  );

  const pullDisabled = $derived(
    Boolean(disabledReason) || git.loading || git.pulling || !git.data?.supported || Boolean(git.error),
  );

  const pullHint = $derived(
    git.error || disabledReason || (status?.pullBranch ? `Pull from origin/${status.pullBranch}` : "Pull from origin"),
  );

  const statusHint = $derived(unavailable || git.error || git.data?.detail);

  const categories = $derived(
    status
      ? [
          { label: "new", count: status.added },
          { label: "modified", count: status.modified },
          { label: "deleted", count: status.deleted },
          { label: "renamed", count: status.renamed },
          { label: "conflicted", count: status.conflicted },
        ].filter((entry) => entry.count > 0)
      : [],
  );
</script>

<div
  class={["grid min-w-0 grid-cols-1", className]}
  {@attach (element) =>
    observeActivity(element, (active) => {
      git.active = active;
    })}
>
  <div
    class="flex min-h-9 min-w-0 items-center gap-2 px-2 text-base/5 text-zinc-700 sm:min-h-8 sm:text-sm/5 dark:text-zinc-300"
  >
    <Icon name="document-text" class="shrink-0" />
    <span class="min-w-0 flex-1">Local changes</span>
    <IconButton
      icon="arrow-path"
      label="Refresh local changes"
      size="sm"
      loading={git.loading}
      aria-disabled={Boolean(unavailable) || git.pulling}
      tooltipText={statusHint || "Refresh local changes"}
      class="aria-disabled:opacity-50"
      onclick={() => {
        if (!unavailable && !git.pulling) void git.reload();
      }}
    />
  </div>
  <div
    role="status"
    class="grid min-w-0 grid-cols-1 gap-1 pr-2 pb-1 pl-8 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
    {@attach tooltip(statusHint)}
  >
    {#if unavailable}<p>Unavailable</p>
    {:else if git.error}<p role="alert" class="text-red-600 dark:text-red-400">
        {git.failureAction === "pull" ? "Pull failed" : "Refresh failed"}
      </p>
    {:else if status?.isRepo}
      {#if status.files}
        <p class="tabular-nums">
          {status.files.toLocaleString()}
          {status.files === 1 ? "uncommitted file" : "uncommitted files"}
        </p>
        <ul role="list" class="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
          {#each categories as category (category.label)}<li>
              {category.count.toLocaleString()}
              {category.label}
            </li>{/each}
        </ul>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums">
          <span class="text-emerald-700 dark:text-emerald-400"
            ><span class="sr-only">Added lines: </span>+{status.additions.toLocaleString()}</span
          >
          <span class="text-red-600 dark:text-red-400"
            ><span class="sr-only">Deleted lines: </span>−{status.deletions.toLocaleString()}</span
          >
          {#if status.binaryFiles}<span
              >{status.binaryFiles.toLocaleString()} {status.binaryFiles === 1 ? "binary file" : "binary files"}</span
            >{/if}
        </div>
        {#if !status.linesComplete}<p {@attach tooltip("Line counts are partial.")}>Partial line counts</p>{/if}
      {:else}<p>No uncommitted changes</p>{/if}
    {:else if git.loading}<p>Checking local changes…</p>
    {:else if git.data?.detail}<p>Unavailable</p>
    {:else if git.data}<p>No Git checkout</p>{/if}
  </div>
  {#if status?.isRepo}
    <div class="pt-1 pr-2 pb-1 pl-8">
      <div class="w-fit max-w-full" {@attach tooltip(pullHint)}>
        <ButtonGroup label="Git actions">
          <Button
            variant="ghost"
            size="sm"
            icon="arrow-down-tray"
            loading={git.pulling}
            aria-label="Pull from origin"
            aria-disabled={pullDisabled}
            class="aria-disabled:opacity-50"
            onclick={() => {
              if (!pullDisabled) void git.pull();
            }}>Pull</Button
          >
        </ButtonGroup>
      </div>
    </div>
  {/if}
</div>
