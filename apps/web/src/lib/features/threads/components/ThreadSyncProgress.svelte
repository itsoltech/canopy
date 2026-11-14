<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { threadSyncCount, threadSyncLabel, threadSyncVisible } from "@canopy/domain/thread-sync-display";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let { status }: { status?: ui.ThreadSyncStatus } = $props();
</script>

<!-- Only while syncing: an empty reserved slot would leave a gap between the tabs and the header actions.
     It appears on the side away from the right-aligned actions, so they never move. -->
{#if status && threadSyncVisible(status)}
  <span
    class="inline-flex shrink-0 items-center gap-1 px-1 text-sm text-zinc-500 tabular-nums max-sm:hidden dark:text-zinc-400"
    title={threadSyncLabel(status)}
    aria-label={threadSyncLabel(status)}
  >
    <Icon name={status.reason ? "exclamation-triangle" : "arrow-path"} />
    {#if !status.reason}<span aria-hidden="true">{threadSyncCount(status.remaining)}</span>{/if}
  </span>
{/if}
