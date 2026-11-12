<script lang="ts">
  import { untrack } from "svelte";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import {
    groupThreadSyncDiagnostics,
    threadSyncComputerStatus,
    threadSyncComputerSummary,
    threadSyncLastTime,
    threadSyncThreads,
  } from "@canopy/domain/thread-sync-display";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode } from "#lib/shared/wire.ts";
  import { useConnectionRequest } from "#lib/features/network/connection-request.svelte.ts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ThreadSyncDiagnostic from "./ThreadSyncDiagnostic.svelte";

  let { computer, class: className }: { computer: ui.ThreadSyncComputer; class?: ClassValue } = $props();
  let open = $state(false);
  let cursors = $state([""]);
  const status = $derived(threadSyncComputerStatus(computer));

  const request = useConnectionRequest(create(ui.ThreadSyncDiagnosticsSchema), async () =>
    decode(
      ui.ThreadSyncDiagnosticsSchema,
      await requestJson("POST", "/api/thread-sync-diagnostics", {
        computerNodeId: computer.nodeId,
        attentionOnly: true,
        after: cursors.at(-1),
        pageSize: 25,
      }),
    ),
  );

  const entries = $derived(
    groupThreadSyncDiagnostics(request.data).computers.find((group) => group.computer.nodeId === computer.nodeId)
      ?.entries ?? [],
  );

  $effect(() => {
    // A new summary arrives on each visible-page refresh. Only expanded rows fetch details.
    const needsAttention = computer.syncingThreads + computer.pausedThreads;
    const cursor = cursors.at(-1);

    if (open && needsAttention && cursor !== undefined) untrack(() => void request.reload());
  });

  function page(back = false) {
    cursors = back ? cursors.slice(0, -1) : [...cursors, request.data.next];
  }
</script>

<div class={["min-w-0 p-3", className]}>
  <Disclosure bind:open>
    {#snippet summary()}
      <span class="flex min-w-0 items-start gap-2">
        <Icon name={status.icon} class="shrink-0" />
        <span class="grid min-w-0 flex-1 gap-1">
          <span class="font-medium break-words">{computer.name}</span>
          <span class="break-words tabular-nums">{threadSyncComputerSummary(computer)}</span>
          {#if !computer.reachable}<span>Unreachable</span>{/if}
          <span class="text-zinc-500 dark:text-zinc-400">{threadSyncLastTime(computer.lastSyncedAtMs)}</span>
        </span>
      </span>
    {/snippet}
    <div class="grid min-w-0 gap-2 pt-3 pl-6">
      {#if computer.hostname !== computer.name}
        <p class="text-sm break-all text-zinc-500 select-text dark:text-zinc-400">{computer.hostname}</p>
      {/if}
      {#if !computer.reachable}<p class="text-sm text-zinc-500 dark:text-zinc-400">
          Reconnect this computer to resume live updates.
        </p>{/if}
      {#if computer.syncingThreads || computer.pausedThreads}
        {#if request.error}<Alert tone="error">Could not load threads. Refresh to retry.</Alert>{/if}
        {#if !request.loaded}<p>Loading threads…</p>{/if}
        {#each entries as entry (entry.threadId)}<ThreadSyncDiagnostic {entry} />{/each}
        {#if cursors.length > 1 || request.data.next}
          <div class="flex flex-wrap justify-end gap-2">
            <Button disabled={request.loading || cursors.length < 2} onclick={() => page(true)}>Previous</Button>
            <Button disabled={request.loading || !request.data.next} onclick={() => page()}>Next</Button>
          </div>
        {/if}
      {/if}
      {#if computer.upToDateThreads}
        <p class="text-sm text-zinc-500 tabular-nums dark:text-zinc-400">
          {threadSyncThreads(computer.upToDateThreads)} up to date
        </p>
      {/if}
    </div>
  </Disclosure>
</div>
