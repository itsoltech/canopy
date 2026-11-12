<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { threadSyncProgress, threadSyncFailure } from "@canopy/domain/thread-sync-display";
  import { formatBytes } from "@canopy/domain/format";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let { entry }: { entry: ui.ThreadSyncDiagnostic } = $props();
</script>

<div class="min-w-0 px-3 py-3">
  <Disclosure>
    {#snippet summary()}
      <span class="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <span class="min-w-0 break-words">{entry.computerName}</span>
        <span class="flex shrink-0 items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
          <Icon name={entry.reason ? "exclamation-triangle" : entry.caughtUp ? "check" : "arrow-path"} />
          {entry.reason ? threadSyncFailure(entry.reason) : threadSyncProgress(entry)}
        </span>
      </span>
    {/snippet}
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 pt-3 text-sm tabular-nums">
      <dt>Applied / available</dt>
      <dd class="text-right break-words">{entry.appliedSeq.toString()} / {entry.headSeq.toString()}</dd>
      <dt>Remaining</dt>
      <dd class="text-right">{entry.remaining.toString()}</dd>
      {#if entry.reason}
        <dt>Failure code</dt>
        <dd class="text-right break-all">{entry.reason} · {entry.code}</dd>
        <dt>Recovery</dt>
        <dd class="text-right">{entry.retryable ? "Automatic retry" : "Waiting for a change"}</dd>
        <dt>Failed frame</dt>
        <dd class="text-right">{entry.frameBytes ? formatBytes(entry.frameBytes) : "Not available"}</dd>
      {/if}
    </dl>
    <div class="flex justify-end pt-3"><ButtonLink href="/threads/{entry.threadId}">Open thread</ButtonLink></div>
  </Disclosure>
</div>
