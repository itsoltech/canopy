<script lang="ts">
  import { onDestroy } from "svelte";
  import { applicationName } from "#lib/application-name.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { agentTools, type ToolWorker } from "@canopy/domain/agent-tool-settings";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import ToolSessionDefaults from "#lib/features/agent-tools/ToolSessionDefaults.svelte";
  import AgentToolCard from "#lib/features/agent-tools/AgentToolCard.svelte";
  import ToolActionNote from "#lib/features/agent-tools/ToolActionNote.svelte";
  import { AgentToolActions } from "#lib/features/agent-tools/agent-tools.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  const overview = useOverview();
  const settings = useSettings();
  const records = workerRecords(overview);
  const actions = new AgentToolActions();

  const workers = $derived<ToolWorker[]>([
    ...overview.ownWorkers.map((worker) => ({ worker, computer: worker.hostname || "This computer", readOnly: "" })),
    ...records.computers.flatMap((computer) =>
      computer.workers.map((item) => ({
        worker: item.worker,
        computer: computer.name,
        readOnly: item.readOnly || (item.away ? "Connect this computer to manage its tools." : ""),
      })),
    ),
  ]);

  onDestroy(() => actions.dispose());
</script>

<svelte:head><title>Agent tools · Settings · {applicationName}</title></svelte:head>

<SettingsHeading title="Agent tools" />
<SettingsTopics
  label="Agent tool settings"
  topics={[
    { id: "access", label: "Worker access", content: access },
    { id: "defaults", label: "Session defaults", content: defaults },
  ]}
/>

{#snippet access()}
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Give agents access to browsers, desktop apps and devices on your workers.
    </p>
    <Button
      size="sm"
      icon="arrow-path"
      loading={Boolean(actions.pending["refresh"])}
      disabled={!workers.some(({ worker, readOnly }) => worker.online && !readOnly)}
      onclick={() => void actions.refresh(workers)}>Check tools</Button
    >
  </div>
  <div class="grid min-w-0 gap-3">
    {#if workers.length}
      {#each agentTools as tool (tool.tool)}<AgentToolCard {...tool} {workers} {actions} />{/each}
      <p class="px-1 text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
        Enabling a tool installs it if needed.
        {#if settings.moduleEnabled("threads")}
          Open Preview in a thread to see and control its screen.{/if}
      </p>
    {:else}
      <SettingsCard class="p-5">
        <p class="font-medium text-zinc-950 dark:text-white">No workers yet</p>
        <div class="mt-3"><ButtonLink href="/settings/workers" size="sm">Add worker</ButtonLink></div>
      </SettingsCard>
    {/if}
    <ToolActionNote {actions} actionKey="refresh" />
    {#if records.error}<Alert tone="error"
        >Could not load workers from linked computers.{#snippet actions()}<Button
            size="sm"
            onclick={() => void records.reload()}>Retry</Button
          >{/snippet}</Alert
      >{/if}
  </div>
{/snippet}

{#snippet defaults()}
  <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    These settings apply across your workers.
  </p>
  {#each agentTools as { tool, name } (tool)}
    <SettingsCard><ToolSessionDefaults {tool} {name} /></SettingsCard>
  {/each}
{/snippet}
