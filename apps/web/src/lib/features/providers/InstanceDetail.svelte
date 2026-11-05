<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import { formatRelative } from "#lib/shared/format.ts";
  import DefinitionForm from "./DefinitionForm.svelte";
  import InstanceMark from "./InstanceMark.svelte";
  import InstanceModels from "./InstanceModels.svelte";
  import { harnessName, instanceName, kindLabel, providerCall, statusOn } from "./instances.ts";
  import LoginPanel from "./LoginPanel.svelte";
  import OverrideForm from "./OverrideForm.svelte";
  import type { ProvidersState } from "./providers-state.svelte.ts";
  import SettingsSection from "./SettingsSection.svelte";
  import SharedInstance from "./SharedInstance.svelte";
  import StatusLine from "./StatusLine.svelte";
  import WorkersField from "./WorkersField.svelte";

  /**
   * The detail of one instance, for the scope chosen above the list: on one worker its status
   * there, sign-in (Codex with its own login), and that worker's overrides; in "All workers" its status everywhere,
   * where it runs, and the global definition. Models and deletion are global in both.
   */
  let {
    instance,
    worker,
    workers,
    state: providers,
    ondeleted,
    class: className,
  }: {
    instance: ui.ProviderInstance;
    worker: ui.Worker | undefined;
    workers: readonly ui.Worker[];
    state: ProvidersState;
    ondeleted: () => void;
    class?: ClassValue;
  } = $props();

  let failure = $state<string>();
  let deleting = $state(false);
  const on = $derived(worker ? instance.workers.find((w) => w.workerId === worker.id) : undefined);
  const nameOf = (workerId: string) => workers.find((w) => w.id === workerId)?.name ?? workerId.slice(-8);
  const onlineOf = (workerId: string) => workers.find((w) => w.id === workerId)?.online ?? false;

  const ownLogin = $derived(
    instance.harness === Provider.CODEX &&
      instance.kind === ProviderProfileKind.NATIVE &&
      instance.runtime?.ownLogin === true,
  );

  async function guarded(run: () => Promise<void>) {
    failure = undefined;

    try {
      await run();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  const setWorkers = (next: { allWorkers: boolean; workerIds: string[] }) =>
    guarded(async () =>
      providers.put((await providerCall("workers", { harness: instance.harness, id: instance.id, ...next })).instance),
    );

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

  <SettingsSection title="Status">
    {#if worker}
      {@const status = statusOn(on, worker.online)}
      <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-base/6 sm:text-sm/6">
        <dt class="text-zinc-500 dark:text-zinc-400">On {worker.name}</dt>
        <dd class="text-zinc-950 dark:text-white"><StatusLine {status} /></dd>
        {#if on?.version}<dt class="text-zinc-500 dark:text-zinc-400">Version</dt>
          <dd class="font-mono text-zinc-950 dark:text-white">{on.version}</dd>{/if}
        {#if on?.reported && !on.available && on.detail}<dt class="text-zinc-500 dark:text-zinc-400">Detail</dt>
          <dd class="text-pretty text-zinc-950 dark:text-white">{on.detail}</dd>{/if}
        {#if on?.checkedAt}<dt class="text-zinc-500 dark:text-zinc-400">Checked</dt>
          <dd class="text-zinc-950 dark:text-white">
            {formatRelative(on.checkedAt)}{on.synced ? "" : " · newer settings on their way"}
          </dd>{/if}
      </dl>
      {#if ownLogin && on?.enabled}
        <LoginPanel {instance} {worker} signedIn={on.authenticated} />
      {/if}
    {:else}
      <InsetList label="Status on each worker">
        {#each instance.workers as w (w.workerId)}
          {@const status = statusOn(w, onlineOf(w.workerId))}
          <li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span
              class="min-w-0 flex-1 basis-full truncate text-base/6 text-zinc-950 sm:basis-auto sm:text-sm/6 dark:text-white"
              >{nameOf(w.workerId)}</span
            >
            {#if w.version}<span class="shrink-0 font-mono text-sm/5 text-zinc-500 sm:text-xs/5">v{w.version}</span
              >{/if}
            <StatusLine {status} class="min-w-0 text-sm/5 text-zinc-600 sm:max-w-[70%] dark:text-zinc-400" />
          </li>
        {:else}
          <li class="px-3 py-2.5 text-base/6 text-zinc-500 sm:text-sm/6">No workers yet.</li>
        {/each}
      </InsetList>
      <WorkersField
        {workers}
        allWorkers={instance.allWorkers}
        workerIds={instance.workers.filter((w) => w.enabled).map((w) => w.workerId)}
        onchange={setWorkers}
      />
    {/if}
  </SettingsSection>

  {#if worker}
    {#if on?.enabled}
      <OverrideForm {instance} {worker} onsaved={(saved) => providers.put(saved)} />
    {:else}
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Turn the instance on for {worker.name} to set its overrides there. Name, color and models are shared by all workers.
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

  <SettingsSection title="Models" description="What the model picker offers for this instance, on every worker.">
    <InstanceModels catalog={providers.models(instance, worker?.id)} models={instance.models} onchange={setModels} />
  </SettingsSection>

  <SharedInstance {instance} />

  {#if !instance.builtIn}
    <SettingsSection
      title="Delete instance"
      description={instance.threadCount > 0
        ? "Threads use it: turn it off on the workers instead."
        : "Removes it from every worker, with its secrets."}
    >
      <div>
        <Button variant="danger" icon="trash" loading={deleting} disabled={instance.threadCount > 0} onclick={remove}
          >Delete {instanceName(instance)}</Button
        >
      </div>
    </SettingsSection>
  {/if}
</div>
