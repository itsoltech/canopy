<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import WorkerActions from "./WorkerActions.svelte";
  import WorkerStatusBadges from "./WorkerStatusBadges.svelte";
  import { workerMeta, workerRoute } from "./worker-summary.ts";
  import type { WorkerSetup } from "./worker-setup.svelte.ts";
  import type { LinkedWorker } from "./worker-records.svelte.ts";

  let {
    worker,
    setup,
    linked,
    onchanged,
  }: {
    worker: ui.Worker;
    setup: WorkerSetup;
    linked?: LinkedWorker;
    onchanged?: () => void;
  } = $props();

  const route = $derived(worker.online && !linked?.away ? workerRoute(worker) : "");
</script>

<SettingsCard class="flex items-center">
  <SettingsRow
    href={`/settings/workers/${encodeURIComponent(worker.id)}`}
    title={worker.name}
    description={workerMeta(worker)}
    class={["min-w-0 flex-1", linked?.away && "opacity-60"]}
  >
    {#if route}<p class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400">{route}</p>{/if}
    <div class="mt-1"><WorkerStatusBadges {worker} {linked} /></div>
  </SettingsRow>
  <WorkerActions {worker} {setup} {linked} {onchanged} class="shrink-0 px-2" />
</SettingsCard>
