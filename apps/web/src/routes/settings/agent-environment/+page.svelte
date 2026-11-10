<script lang="ts">
  import { untrack } from "svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { EnvironmentState } from "#lib/features/agent-environment/environment-state.svelte.ts";
  import InstructionLibrary from "#lib/features/agent-environment/InstructionLibrary.svelte";
  import SkillsLibrary from "#lib/features/agent-environment/SkillsLibrary.svelte";
  import MarketplaceLibrary from "#lib/features/agent-environment/MarketplaceLibrary.svelte";
  import ComputerPlugins from "#lib/features/agent-environment/ComputerPlugins.svelte";
  import EnvironmentComputer from "#lib/features/agent-environment/EnvironmentComputer.svelte";
  import EnvironmentNotices from "#lib/features/agent-environment/EnvironmentNotices.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import type { PageProps } from "./$types";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";
  import RemoteEnvironment from "#lib/features/agent-environment/RemoteEnvironment.svelte";
  import LibrarySummary from "#lib/features/agent-environment/LibrarySummary.svelte";

  let { data }: PageProps = $props();
  const overview = useOverview();
  const records = workerRecords(overview);

  const state = new EnvironmentState(
    untrack(() => data.environment),
    undefined,
    () => records.records,
  );

  const selectedWorker = $derived(records.workers.find((w) => w.id === state.workerId) ?? records.workers[0]);

  const worker = $derived(
    state.snapshot.workers.find((w) => w.workerId === state.workerId) ?? state.snapshot.workers[0],
  );
</script>

<div class="settings-stack">
  <SettingsHeading title="Agent environment" description="Assign library items to computers or tags to install them." />
  <LibrarySummary environment={state} />
  <EnvironmentNotices onchange={() => void state.refresh()} />
  {#if state.error}<Alert tone="error">{state.error}</Alert>{/if}
  {#if state.notice}<Alert>{state.notice}</Alert>{/if}
  <InstructionLibrary {state} />
  <SkillsLibrary environment={state} />
  <MarketplaceLibrary environment={state} />
  <section
    class="grid min-w-0 gap-3 border-t border-zinc-950/10 pt-4 dark:border-white/10"
    aria-label="Environment computers"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-lg font-semibold text-balance">Computers & preview</h2>
      {#if !selectedWorker?.nodeId}<Button
          size="sm"
          variant="ghost"
          disabled={state.busy}
          onclick={() => state.refresh()}>Refresh status</Button
        >{/if}
    </div>
    {#if selectedWorker}
      <Field label="Computer" class="min-w-0"
        ><Select
          class="min-w-0"
          name="environment-computer"
          bind:value={state.workerId}
          options={records.options()}
        /></Field
      >
      {#if selectedWorker.nodeId}
        {#key selectedWorker.id}<RemoteEnvironment
            workerId={selectedWorker.id}
            readOnly={records.readOnly(selectedWorker.id)}
          />{/key}
      {:else if worker}
        <div class="flex flex-wrap gap-2">
          <Badge>{worker.online ? "Online" : "Offline"}</Badge><Badge>This computer's workers</Badge>
        </div>
        {#key worker.workerId}<EnvironmentComputer {worker} {state} />{/key}
        {#key worker.workerId}<ComputerPlugins {worker} environment={state} />{/key}
      {/if}
    {:else}<p class="text-base text-pretty text-zinc-500 sm:text-sm dark:text-zinc-400">
        Add a worker in Settings → Workers to preview and sync instructions.
      </p>{/if}
  </section>
</div>
