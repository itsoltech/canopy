<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import type { EnvironmentState } from "#lib/features/agent-environment/environment-state.svelte.ts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import WorkerActions from "./WorkerActions.svelte";
  import WorkerDetails from "./WorkerDetails.svelte";
  import WorkerStatusBadges from "./WorkerStatusBadges.svelte";
  import { workerMeta, workerRoute } from "./worker-summary.ts";
  import type { WorkerSetup } from "./worker-setup.svelte.ts";
  import type { LinkedWorker } from "./worker-records.svelte.ts";

  /** One worker as its own card: name and status in the header, everything else in flat sections when expanded. */
  let {
    worker,
    setup,
    environment,
    linked,
    onchanged,
    class: className,
  }: {
    worker: ui.Worker;
    setup: WorkerSetup;
    environment: EnvironmentState;
    /** Another computer's worker: its home applies every change, or the row is read-only with the reason. */
    linked?: LinkedWorker;
    onchanged?: () => void;
    class?: ClassValue;
  } = $props();

  const readOnly = $derived(linked?.readOnly ?? "");
  const online = $derived(worker.online && !readOnly);
  const route = $derived(online ? workerRoute(worker) : "");

  // Height of the summary's content: the "…" menu (outside <summary>, so it does not toggle it) centres on that row.
  let summaryHeight = $state(48);
</script>

<SettingsCard class={["relative", className]}>
  <Disclosure align="center" summaryClass="min-h-18 p-4 pr-14 sm:px-5 sm:pr-16">
    {#snippet summary()}
      <div class={["flex items-center gap-3", readOnly && "opacity-60"]} bind:clientHeight={summaryHeight}>
        <div class="grid size-10 shrink-0 place-items-center rounded-xl bg-zinc-950/5 text-zinc-500 dark:bg-white/5">
          <Icon name="computer-desktop" />
        </div>
        <!-- Badges wrap under the name on narrow screens instead of squeezing it. -->
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
          <div class="min-w-0 flex-[1_1_14rem] text-base/6 sm:text-sm/6">
            <p class="truncate font-medium text-zinc-950 dark:text-white" title={worker.name}>{worker.name}</p>
            <p class="text-pretty break-words text-zinc-500 dark:text-zinc-400">{workerMeta(worker)}</p>
            {#if route}<p class="text-pretty break-words text-zinc-500 dark:text-zinc-400">{route}</p>{/if}
          </div>
          <WorkerStatusBadges {worker} {linked} />
        </div>
      </div>
    {/snippet}
    <WorkerDetails {worker} {environment} {linked} {onchanged} class="border-t border-zinc-950/5 dark:border-white/8" />
  </Disclosure>
  <!-- The summary's padding is 1rem above and below its content (p-4). -->
  <div class="absolute top-0 right-2 flex items-center sm:right-4" style:height="max(4.5rem, {summaryHeight + 32}px)">
    <WorkerActions {worker} {setup} {linked} {onchanged} />
  </div>
</SettingsCard>
