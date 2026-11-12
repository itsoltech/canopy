<script lang="ts">
  import { onMount } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { groupThreadSyncDiagnostics, threadSyncLastTime, threadSyncTotals } from "@canopy/domain/thread-sync-display";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { useConnectionRequest } from "#lib/features/network/connection-request.svelte.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ThreadSyncComputer from "./ThreadSyncComputer.svelte";

  const request = useConnectionRequest(create(ui.ThreadSyncDiagnosticsSchema), async () =>
    decode(
      ui.ThreadSyncDiagnosticsSchema,
      await requestJson("POST", "/api/thread-sync-diagnostics", { summaryOnly: true }),
    ),
  );

  const grouped = $derived(groupThreadSyncDiagnostics(request.data));

  onMount(() => {
    void request.reload();

    const timer = setInterval(() => {
      if (!document.hidden) void request.reload();
    }, 5000);

    return () => clearInterval(timer);
  });
</script>

<SettingsGroup title="Thread sync" description="Sync with linked computers.">
  {#snippet actions()}
    <IconButton
      icon="arrow-path"
      label="Refresh sync status"
      disabled={request.loading}
      onclick={() => void request.reload()}
    />
  {/snippet}
  {#if request.error}
    <div class="p-3"><Alert tone="error">Could not load sync status. Refresh to retry.</Alert></div>
  {/if}
  {#if !request.loaded}
    <p class="p-3">Loading sync status…</p>
  {:else if !grouped.computers.length}
    <p class="p-3 text-zinc-500 dark:text-zinc-400">No threads synced from linked computers</p>
  {:else if grouped.allCaughtUp}
    <div class="flex items-start gap-2 p-3" role="status">
      <Icon name="check" class="shrink-0" />
      <div class="grid min-w-0 gap-1">
        <p>All threads are up to date</p>
        <p class="text-sm text-zinc-500 dark:text-zinc-400">{threadSyncLastTime(grouped.lastSyncedAtMs)}</p>
      </div>
    </div>
  {:else}
    {#if grouped.syncing || grouped.paused}
      <p class="p-3 tabular-nums" role="status">
        {threadSyncTotals(grouped.syncing, grouped.paused, grouped.remaining)}
      </p>
    {/if}
    {#each grouped.computers as { computer } (computer.nodeId)}<ThreadSyncComputer {computer} />{/each}
  {/if}
</SettingsGroup>
