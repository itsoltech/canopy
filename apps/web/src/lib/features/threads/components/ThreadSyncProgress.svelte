<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { threadSyncCount, threadSyncLabel, threadSyncVisible } from "@canopy/domain/thread-sync-display";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let { status }: { status?: ui.ThreadSyncStatus } = $props();
</script>

<span class="inline-flex w-16 shrink-0 justify-end text-sm text-zinc-500 tabular-nums dark:text-zinc-400">
  {#if status && threadSyncVisible(status)}
    <span class="inline-flex items-center gap-1" title={threadSyncLabel(status)} aria-label={threadSyncLabel(status)}>
      <Icon name={status.reason ? "exclamation-triangle" : "arrow-path"} />
      {#if !status.reason}<span aria-hidden="true">{threadSyncCount(status.remaining)}</span>{/if}
    </span>
  {/if}
</span>
