<script lang="ts">
  import { sharedProxies } from "#lib/features/proxies/proxies.ts";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import type { ClassValue } from "svelte/elements";
  import { ProviderProfileKind, type ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import DefinitionForm from "./DefinitionForm.svelte";
  import InstanceMark from "./InstanceMark.svelte";
  import InstanceModels from "./InstanceModels.svelte";
  import { harnessName, instanceName, kindLabel, providerCall, statusAcross, statusOn } from "./instances.ts";
  import InstanceWorkerStatus from "./InstanceWorkerStatus.svelte";
  import OverrideForm from "./OverrideForm.svelte";
  import type { ProvidersState } from "./providers-state.svelte.ts";
  import SettingsSection from "./SettingsSection.svelte";
  import InstanceNotices from "./InstanceNotices.svelte";
  import StatusLine from "./StatusLine.svelte";
  import WorkersField from "./WorkersField.svelte";
  import ProxyThrough from "./ProxyThrough.svelte";
  import type { WorkerRecords } from "#lib/features/workers/worker-records.svelte.ts";

  /**
   * The detail of one instance, for the scope chosen above the list: on one worker its status
   * there, sign-in, and that worker's overrides; in "All workers" its readiness, where it runs,
   * and the global definition. The status picker inspects a worker without changing the editing scope.
   */
  let {
    instance,
    worker,
    workers,
    state: providers,
    records,
    ondeleted,
    class: className,
  }: {
    instance: ui.ProviderInstance;
    worker: ui.Worker | undefined;
    workers: readonly ui.Worker[];
    state: ProvidersState;
    records: WorkerRecords;
    ondeleted: () => void;
    class?: ClassValue;
  } = $props();

  let failure = $state<string>();
  let deleting = $state(false);
  let inspectedId = $state("");
  const pickerId = $props.id();
  const proxies = sharedProxies();
  const onByWorker = $derived(new Map(instance.workers.map((on) => [on.workerId, on])));
  const on = $derived(worker ? onByWorker.get(worker.id) : undefined);

  const statusWorker = $derived(
    worker ?? (workers.length === 1 ? workers[0] : workers.find((w) => w.id === inspectedId)),
  );

  const statusOptions = $derived.by(() => [
    { value: "", label: "Summary" },
    ...records.options(workers).map((option) => ({
      ...option,
      description: statusOn(onByWorker.get(option.value), option.online ?? false).label,
    })),
  ]);

  const enabledWorkers = $derived(instance.workers.filter((w) => w.enabled));

  function proxyOn(on?: ui.InstanceOnWorker): string {
    const overrides = on?.overrides;

    // A worker can still have a saved endpoint override from before shared proxies.
    return overrides?.proxyId || (overrides?.baseUrl === undefined ? instance.proxyId : "");
  }

  const proxyIds = $derived.by(() => {
    if (instance.kind !== ProviderProfileKind.CLIPROXYAPI) return new Set<string>();

    const ids = statusWorker
      ? [proxyOn(onByWorker.get(statusWorker.id))]
      : enabledWorkers.length
        ? enabledWorkers.map(proxyOn)
        : [instance.proxyId];

    return new Set(ids.filter(Boolean));
  });

  const proxyConnections = $derived(proxies.data?.proxies.filter((proxy) => proxyIds.has(proxy.id)) ?? []);

  async function guarded(run: () => Promise<void>) {
    failure = undefined;

    try {
      await run();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  let savingWorkers = $state(false);

  const setWorkers = async (next: { allWorkers: boolean; workerIds: string[] }) => {
    savingWorkers = true;
    await guarded(async () => {
      await providerCall("workers", { harness: instance.harness, id: instance.id, ...next });
      await providers.reload();
      await records.reload();
    });
    savingWorkers = false;
  };

  const setModels = (models: ui.InstanceModels) =>
    guarded(async () =>
      providers.put((await providerCall("models", { harness: instance.harness, id: instance.id, models })).instance),
    );

  async function remove() {
    if (!confirm(`Delete ${instanceName(instance)}? Its secrets are deleted too.`)) return;
    deleting = true;
    await guarded(async () => {
      await providerCall("delete", { harness: instance.harness, id: instance.id, expectedRevision: instance.revision });
      await providers.reload();
      ondeleted();
    });
    deleting = false;
  }
</script>

<div class={["settings-stack", className]}>
  <header class="flex items-start gap-3">
    <InstanceMark {instance} />
    <div class="min-w-0 flex-1">
      <h2 class="truncate text-base/6 font-semibold text-zinc-950 dark:text-white">{instanceName(instance)}</h2>
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        <span>{harnessName(instance.harness)}</span><span aria-hidden="true">·</span><span class="font-mono"
          >{instance.id}</span
        ><span aria-hidden="true">·</span><span>{kindLabel(instance.kind)}</span>
        {#if instance.builtIn}<Badge>Built-in</Badge>{/if}
        {#if instance.threadCount > 0}<Badge tone="sky"
            >{instance.threadCount} thread{instance.threadCount === 1 ? "" : "s"}</Badge
          >{/if}
      </p>
    </div>
  </header>

  {#if failure}<Alert tone="error">{failure}</Alert>{/if}
  <InstanceNotices {instance} />

  <SettingsTopics
    label="Provider instance settings"
    topics={[
      { id: "status", label: "Status and access", content: statusAndAccess },
      { id: "configuration", label: "Configuration", content: configuration },
      { id: "models", label: "Models", content: models },
    ]}
  />
</div>

{#snippet statusAndAccess()}
  <SettingsSection title="Status">
    {#if !worker && workers.length > 1}
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <StatusLine status={statusAcross(instance)} class="text-base/6 sm:text-sm/6" />
        <div class="flex max-w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <label for={pickerId} class="text-base/6 text-muted sm:text-sm/6">Worker details</label>
          <Select
            id={pickerId}
            aria-label="Worker details"
            value={statusWorker?.id ?? ""}
            options={statusOptions}
            onchange={(id) => (inspectedId = id)}
            class="w-48 max-w-full"
          />
        </div>
      </div>
    {:else if !statusWorker}
      <p class="text-base/6 text-muted sm:text-sm/6">No workers yet.</p>
    {:else if !worker}
      <p class="text-base/6 font-medium wrap-anywhere sm:text-sm/6">{statusWorker.name}</p>
    {/if}
    {#if statusWorker}
      {#key statusWorker.id}
        <InstanceWorkerStatus
          {instance}
          worker={statusWorker}
          on={onByWorker.get(statusWorker.id)}
          onupdated={() => providers.reload()}
        />
      {/key}
    {/if}
    {#if !worker}
      <WorkersField
        {workers}
        {records}
        allWorkers={instance.allWorkers}
        workerIds={enabledWorkers.map((w) => w.workerId)}
        saving={savingWorkers}
        onchange={(next) => void setWorkers(next)}
      />
    {/if}
  </SettingsSection>

  {#if proxyConnections.length}
    <SettingsSection title="Proxy connection">
      {#each proxyConnections as proxy (proxy.id)}
        <ProxyThrough {proxy} harness={instance.harness} />
      {/each}
    </SettingsSection>
  {/if}
{/snippet}

{#snippet configuration()}
  {#if worker}
    {#if on?.enabled}
      <OverrideForm
        {instance}
        {worker}
        readOnly={records.readOnly(worker.id)}
        onsaved={() => {
          void providers.reload();
          void records.reload();
        }}
      />
    {:else}
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Turn this instance on for {worker.name} to configure its overrides.
      </p>
    {/if}
  {:else}
    <DefinitionForm
      {instance}
      onsaved={(saved) => {
        providers.put(saved);
        void providers.reload();
      }}
    />
  {/if}

  {#if !instance.builtIn}
    <SettingsSection
      title="Delete instance from all workers"
      description={instance.threadCount > 0
        ? "Threads use this instance. You can turn it off on individual workers."
        : "Deleting this instance also deletes its secrets."}
    >
      <div>
        <Button variant="danger" icon="trash" loading={deleting} disabled={instance.threadCount > 0} onclick={remove}
          >Delete {instanceName(instance)}</Button
        >
      </div>
    </SettingsSection>
  {/if}
{/snippet}

{#snippet models()}
  <SettingsSection title="Models" description="What the model picker offers for this instance, on every worker.">
    <InstanceModels catalog={providers.models(instance, worker?.id)} models={instance.models} onchange={setModels} />
  </SettingsSection>
{/snippet}
