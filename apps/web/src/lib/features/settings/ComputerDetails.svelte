<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import RouteList from "#lib/features/computers/RouteList.svelte";
  import { needsThreadUpdate, needsMirrorUpdate } from "#lib/features/computers/computers.ts";
  let { computer, self = false, busy = false, now = Date.now(), onrename, onunlink, onaddroute, onremoveroute, onshare, onmove, class: className }: {
    computer: ui.LinkedComputer; self?: boolean; busy?: boolean; now?: number; onrename: () => void; onunlink?: () => void;
    onaddroute?: () => void; onremoveroute?: (address: string) => void; onshare?: () => void; onmove?: () => void; class?: ClassValue;
  } = $props();
  const date = (value: bigint) => value ? new Date(Number(value)).toLocaleString() : "Never";
  const status = $derived(computer.status === "connected" ? "Connected" : computer.status === "needs_update" ?
    (computer.updateNodeId === computer.nodeId ? `${computer.displayName || computer.name} needs an update` : "This computer needs an update") :
    computer.status === "updating" ? "Updating…" : computer.status === "sleeping" ? "Going to sleep" : computer.status === "shutting_down" ? "Shutting down" :
    computer.status === "pairing_required" ? "Certificate changed or pairing was removed. Unlink and pair again." : "Unreachable");
</script>

<div class={["grid min-w-0 gap-4 p-4", className]}>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 class="break-words text-base font-semibold text-zinc-950 dark:text-white">{computer.displayName || computer.name}</h3>
        {#if computer.viaNodeId}<Badge icon="link">via {computer.viaName}</Badge>{/if}
        {#if !self && needsThreadUpdate(computer)}<Badge tone="amber" icon="arrow-path">Needs an update</Badge>{/if}
      </div>
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{self ? "This computer" : status}</p>
      {#if computer.relayOrigin}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Can access this computer through {computer.viaName}. This entry is read only; manage sharing on {computer.viaName}.</p>
      {:else if computer.viaNodeId}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{computer.unavailableReason || `Access passes through ${computer.viaName}. Manage sharing on that computer.`}</p>{/if}
      {#if !self && needsThreadUpdate(computer)}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Its threads appear here after it updates to a Canopy version that shares them.</p>{/if}
      {#if !self && needsMirrorUpdate(computer)}<p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Needs an update for offline reading. Its threads are available only while connected.</p>{/if}
      {#if !self && computer.status !== "connected"}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">Since {date(computer.statusSinceMs)}</p>{/if}
    </div>
    {#if !computer.viaNodeId}<div class="flex flex-wrap gap-2">
      {#if onmove}<Button size="sm" variant="ghost" icon="arrows-right-left" disabled={busy} onclick={onmove}>Move everything here</Button>{/if}
      {#if onshare}<Button size="sm" variant="ghost" disabled={busy} onclick={onshare}>Share onward{computer.shareOnwardNodeIds.length ? ` · ${computer.shareOnwardNodeIds.length}` : ""}</Button>{/if}
      <Button size="sm" variant="ghost" disabled={busy} onclick={onrename}>Rename</Button>
      {#if onunlink}<Button size="sm" variant="ghost" disabled={busy} onclick={onunlink}>Unlink</Button>{/if}
    </div>{/if}
  </div>
  <dl class="grid min-w-0 gap-3 text-base/6 sm:text-sm/6">
    <div><dt class="text-zinc-500 dark:text-zinc-400">Version</dt><dd class="text-zinc-950 dark:text-white">{computer.appVersion || "Not connected yet"}{#if !computer.viaNodeId} · Link {computer.minProtocol}–{computer.maxProtocol}{/if}</dd></div>
    {#if !computer.viaNodeId}<div class="min-w-0"><dt class="text-zinc-500 dark:text-zinc-400">Certificate fingerprint · SHA-256</dt><dd class="break-all font-mono text-zinc-700 dark:text-zinc-300">{computer.fingerprint.match(/.{1,4}/g)?.join(" ")}</dd></div>{/if}
    {#if self}<div class="min-w-0"><dt class="text-zinc-500 dark:text-zinc-400">Addresses</dt><dd class="break-all text-zinc-700 dark:text-zinc-300">{computer.addresses.join(" · ") || "Listener is off or no address is advertised."}</dd></div>{/if}
    {#if !self}<div><dt class="text-zinc-500 dark:text-zinc-400">Last seen</dt><dd class="tabular-nums text-zinc-700 dark:text-zinc-300">{date(computer.lastSeenMs)}</dd></div>{/if}
  </dl>
  {#if !self && !computer.viaNodeId && onaddroute && onremoveroute}<RouteList {computer} {now} {busy} onadd={onaddroute} onremove={onremoveroute} />{/if}
</div>
