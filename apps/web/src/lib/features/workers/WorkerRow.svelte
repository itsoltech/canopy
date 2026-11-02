<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import WorkerSettings from "#lib/features/overview/WorkerSettings.svelte";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import { providerLabel } from "#lib/features/threads/labels.ts";
  import WorkerActions from "./WorkerActions.svelte";
  import type { WorkerSetup } from "./worker-setup.svelte.ts";
  let { worker, setup, class: className }: { worker: ui.Worker; setup: WorkerSetup; class?: ClassValue } = $props();
  const status = $derived(worker.revokedAt ? "Revoked" : worker.online ? "Connected" : "Disconnected");
  const statusLine = $derived([worker.hostname, worker.os && osLabel(worker.os), status,
    ...worker.providers.filter((p) => p.version).map((p) => `${providerLabel(p.provider)} ${p.version}`)].filter(Boolean).join(" · "));
</script>

<div class={["relative border-b border-zinc-950/5 last:border-0 dark:border-white/10", className]}>
  <Disclosure summaryClass="min-h-20 items-center p-4 pr-16 sm:px-5 sm:pr-16">
    {#snippet summary()}
      <div class="flex items-center gap-3">
        <div class="grid size-10 shrink-0 place-items-center rounded-xl bg-zinc-950/5 text-zinc-500 dark:bg-white/5"><Icon name="computer-desktop" /></div>
        <div class="min-w-0 flex-1 text-base/6 sm:text-sm/6">
          <p class="truncate font-medium text-zinc-950 dark:text-white">{worker.name}</p>
          <p class="text-pretty text-zinc-500 dark:text-zinc-400">{statusLine}</p>
        </div>
        <div class="shrink-0 max-sm:hidden"><Badge tone={worker.revokedAt ? "rose" : worker.online ? "emerald" : "neutral"}>{status}</Badge></div>
      </div>
    {/snippet}
    <div class="px-4 pb-4 sm:px-5"><WorkerSettings {worker} title="Machine details" /></div>
  </Disclosure>
  <div class="absolute top-5 right-3 sm:right-4"><WorkerActions {worker} {setup} /></div>
</div>
