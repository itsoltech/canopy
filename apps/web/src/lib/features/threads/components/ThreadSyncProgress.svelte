<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { threadSyncProgress, threadSyncCount } from "@canopy/domain/thread-sync-display";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let { status }: { status?: ui.ThreadSyncStatus } = $props();
</script>

<span class="inline-flex w-16 shrink-0 justify-end text-sm text-zinc-500 tabular-nums dark:text-zinc-400">
  {#if status}
    <span
      class="inline-flex items-center gap-1"
      title={threadSyncProgress(status)}
      aria-label={threadSyncProgress(status)}
    >
      <Icon name={status.reason ? "exclamation-triangle" : status.caughtUp ? "check" : "arrow-path"} />
      <span aria-hidden="true">{threadSyncCount(status.remaining)}</span>
    </span>
  {/if}
</span>
