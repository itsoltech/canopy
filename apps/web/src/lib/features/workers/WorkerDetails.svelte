<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { EnvironmentState } from "#lib/features/agent-environment/environment-state.svelte.ts";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsCard from "#lib/shared/ui/SettingsCard.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import WorkerAccounts from "./WorkerAccounts.svelte";
  import WorkerCliTools from "./WorkerCliTools.svelte";
  import WorkerConfiguration from "./WorkerConfiguration.svelte";
  import WorkerTagEditor from "./WorkerTagEditor.svelte";
  import type { LinkedWorker } from "./worker-records.svelte.ts";

  let {
    worker,
    environment,
    linked,
    cliAnchor,
    defaultTopic,
    onchanged,
  }: {
    worker: ui.Worker;
    environment: EnvironmentState;
    linked?: LinkedWorker | undefined;
    cliAnchor: string;
    defaultTopic?: string | undefined;
    onchanged: () => void;
  } = $props();

  const readOnly = $derived(linked?.readOnly ?? "");
</script>

{#if readOnly}<Alert title={readOnly}>These are the last saved settings.</Alert>{/if}
<SettingsTopics
  label="Worker details"
  {defaultTopic}
  topics={[
    { id: "configuration", label: "Configuration", content: configuration },
    { id: "agent-clis", label: "Agent CLIs", content: clis },
    { id: "tags", label: "Tags", content: tags },
  ]}
/>

{#snippet configuration()}
  <SettingsCard class="divide-y divide-zinc-950/5 dark:divide-white/8">
    <WorkerConfiguration {worker} />
    <WorkerAccounts {worker} online={worker.online && !readOnly} />
  </SettingsCard>
{/snippet}

{#snippet clis()}
  <SettingsCard><WorkerCliTools {worker} {readOnly} anchor={cliAnchor} /></SettingsCard>
{/snippet}

{#snippet tags()}
  <SettingsCard><WorkerTagEditor {worker} {environment} {linked} {onchanged} /></SettingsCard>
  {#if environment.error}
    <Alert tone="error">
      {environment.error}
      {#snippet actions()}<Button size="sm" onclick={() => void environment.refresh()}>Refresh tags</Button>{/snippet}
    </Alert>
  {/if}
{/snippet}
