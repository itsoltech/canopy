<script lang="ts">
  import { onMount } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { formatCount } from "@canopy/domain/format";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { useConnectionRequest } from "#lib/features/network/connection-request.svelte.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ThreadSyncDiagnostic from "./ThreadSyncDiagnostic.svelte";

  let cursors = $state([""]);
  let after = $state("");

  const request = useConnectionRequest(create(ui.ThreadSyncDiagnosticsSchema), async () =>
    decode(
      ui.ThreadSyncDiagnosticsSchema,
      await requestJson("POST", "/api/thread-sync-diagnostics", { after, pageSize: 50 }),
    ),
  );

  function page(cursor: string, back = false) {
    if (back) cursors = cursors.slice(0, -1);
    else cursors = [...cursors, cursor];
    after = cursor;
    void request.reload();
  }

  onMount(() => {
    void request.reload();

    const timer = setInterval(() => {
      if (!document.hidden) void request.reload();
    }, 5000);

    return () => clearInterval(timer);
  });
</script>

{#if request.error}<Alert tone="error">Could not load sync diagnostics. Retry when the gateway is available.</Alert
  >{/if}
<SettingsGroup
  title="Thread sync"
  description="Progress on this gateway. Saved messages stay available while a computer is unreachable."
>
  {#snippet actions()}<Button disabled={request.loading} onclick={() => void request.reload()}>Refresh</Button
    >{/snippet}
  <SettingsRow title="Remaining" description="Records still needed to catch up with linked computers.">
    {#snippet control()}<span title={request.data.remaining.toString()}
        >{formatCount(request.data.remaining)} to go</span
      >{/snippet}
  </SettingsRow>
  <SettingsRow title="Threads" description="Catching up / paused">
    {#snippet control()}<span>{request.data.syncingThreads} / {request.data.failedThreads}</span>{/snippet}
  </SettingsRow>
  {#each request.data.entries as entry (entry.threadId)}<ThreadSyncDiagnostic {entry} />{/each}
  {#if !request.data.entries.length}<SettingsRow
      title={request.loaded ? "No mirrored threads on this page" : "Loading sync progress…"}
    />{/if}
</SettingsGroup>
{#if cursors.length > 1 || request.data.next}
  <div class="flex justify-end gap-2">
    <Button disabled={request.loading || cursors.length < 2} onclick={() => page(cursors.at(-2) ?? "", true)}
      >Previous</Button
    >
    <Button disabled={request.loading || !request.data.next} onclick={() => page(request.data.next)}>Next</Button>
  </div>
{/if}
