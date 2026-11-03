<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { swap } from "#lib/shared/ui/motion.ts";
  import { updateBusy, updateStateLabel } from "./updates.svelte.ts";

  let { worker, gatewayVersion, admin, pending, onupdate, class: className }: {
    worker: ui.WorkerUpdate; gatewayVersion: string; admin: boolean; pending: string;
    onupdate(): void; class?: ClassValue;
  } = $props();
  const busy = $derived(updateBusy(worker.state));
</script>

<div class={["flex flex-col items-start gap-3 sm:flex-row sm:items-center", className]}>
  <div class="min-w-0 flex-1 space-y-1">
    <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{worker.name} <span class="font-mono font-normal tabular-nums text-zinc-500 dark:text-zinc-400">{worker.version || "Version unknown"}</span></p>
    <div class="flex flex-wrap items-center gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      {#key `${worker.state}/${worker.compatibility}`}
        <div in:swap role="status"><Badge tone={worker.state === "failed" ? "rose" : worker.state === "managed_externally" ? "neutral" : busy || worker.compatibility !== "compatible" ? "amber" : "emerald"}>{updateStateLabel(worker.state, worker.compatibility === "compatible")}</Badge></div>
      {/key}
      <p>{worker.connected ? "Update channel connected" : "Update channel offline"}</p>
    </div>
    {#if worker.reason}<p class="text-base/6 text-pretty break-words text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{worker.reason}</p>{/if}
  </div>
  {#if worker.installKind === "binary" && admin}
    <div class="shrink-0"><Button size="sm" loading={pending === worker.workerId || busy} disabled={!!pending || worker.version === gatewayVersion} onclick={onupdate}>Update worker</Button></div>
  {/if}
</div>
