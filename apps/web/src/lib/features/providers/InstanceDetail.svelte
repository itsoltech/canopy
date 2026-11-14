<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
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
  import { signsInFromApp } from "./device-login.svelte.ts";
  import OverrideForm from "./OverrideForm.svelte";
  import type { ProvidersState } from "./providers-state.svelte.ts";
  import SettingsSection from "./SettingsSection.svelte";
  import InstanceNotices from "./InstanceNotices.svelte";
  import StatusLine from "./StatusLine.svelte";
  import WorkersField from "./WorkersField.svelte";
  import AccountStatusRow, { hasAccountStatus } from "./AccountStatusRow.svelte";
  import UsageMeters from "./UsageMeters.svelte";
  import ProxyThrough from "./ProxyThrough.svelte";
  import type { WorkerRecords } from "#lib/features/workers/worker-records.svelte.ts";

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
  const on = $derived(worker ? instance.workers.find((w) => w.workerId === worker.id) : undefined);
  const accountShown = $derived(!!on?.enabled && hasAccountStatus(on.account));
  const nameOf = (workerId: string) => workers.find((w) => w.id === workerId)?.name ?? workerId.slice(-8);
  const onlineOf = (workerId: string) => workers.find((w) => w.id === workerId)?.online ?? false;

  const appSignIn = $derived(signsInFromApp(instance.harness, instance.kind));

  async function guarded(run: () => Promise<void>) {
    failure = undefined;

    try {
      await run();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  const setWorkers = (next: { allWorkers: boolean; workerIds: string[] }) =>
    guarded(async () => {
      await providerCall("workers", { harness: instance.harness, id: instance.id, ...next });
      await providers.reload();
      await records.reload();
    });

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

  <SettingsSection title="Status">
    {#if instance.proxyId}<ProxyThrough {instance} />{/if}
    {#if worker}
      {@const status = statusOn(on, worker.online)}
      <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-base/6 sm:text-sm/6">
        <dt class="max-w-28 truncate text-zinc-500 sm:max-w-48 dark:text-zinc-400" title={worker.name}>
          On {worker.name}
        </dt>
        <dd class="text-zinc-950 dark:text-white"><StatusLine {status} /></dd>
        {#if on?.version}<dt class="text-zinc-500 dark:text-zinc-400">Version</dt>
          <dd class="font-mono text-zinc-950 dark:text-white">{on.version}</dd>{/if}
        {#if on?.reported && on.account?.authMethod !== "Proxy"}<dt class="text-zinc-500 dark:text-zinc-400">
            Connection
          </dt>
          <dd class="text-zinc-950 dark:text-white">{kindLabel(on.kind)}</dd>{/if}
        {#if on?.reported && !on.available && on.detail}<dt class="text-zinc-500 dark:text-zinc-400">Detail</dt>
          <dd class="text-pretty text-zinc-950 dark:text-white">{on.detail}</dd>{/if}
        {#if on?.checkedAt && !accountShown}<dt class="text-zinc-500 dark:text-zinc-400">Checked</dt>
          <dd class="text-zinc-950 dark:text-white">
            {formatRelative(on.checkedAt)}{on.synced ? "" : " · newer settings on their way"}
          </dd>{:else if on?.reported && !on.synced}<dt class="text-zinc-500 dark:text-zinc-400">Settings</dt>
          <dd class="text-zinc-950 dark:text-white">Newer settings on their way</dd>{/if}
        {#if on && accountShown}<dt class="text-zinc-500 dark:text-zinc-400">Account</dt>
          <dd class="-my-0.5 min-w-0">
            <AccountStatusRow
              account={on.account}
              workerId={worker.id}
              harness={instance.harness}
              id={instance.id}
              online={worker.online}
              os={worker.os}
              onupdated={() => providers.reload()}
            />
          </dd>{/if}
      </dl>
      <UsageMeters usage={on?.usage} />
      {#if appSignIn && on?.enabled}
        <LoginPanel {instance} {worker} {on} />
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
            {#if w.reported && w.account?.authMethod !== "Proxy"}<p
                class="basis-full text-sm/5 text-zinc-500 dark:text-zinc-400"
              >
                {kindLabel(w.kind)}
                {#if !hasAccountStatus(w.account)}
                  · {w.checkedAt ? `Checked ${formatRelative(w.checkedAt)}` : "Check time unknown"}
                {/if}
              </p>{/if}
            {#if w.enabled && hasAccountStatus(w.account)}<div class="min-w-0 basis-full">
                <AccountStatusRow
                  account={w.account}
                  workerId={w.workerId}
                  harness={instance.harness}
                  id={instance.id}
                  online={onlineOf(w.workerId)}
                  os={workers.find((worker) => worker.id === w.workerId)?.os ?? ""}
                  onupdated={() => providers.reload()}
                />
              </div>{/if}
            <UsageMeters usage={w.usage} class="basis-full" />
          </li>
        {:else}
          <li class="px-3 py-2.5 text-base/6 text-zinc-500 sm:text-sm/6">No workers yet.</li>
        {/each}
      </InsetList>
      <WorkersField
        {workers}
        {records}
        allWorkers={instance.allWorkers}
        workerIds={instance.workers.filter((w) => w.enabled).map((w) => w.workerId)}
        onchange={setWorkers}
      />
    {/if}
  </SettingsSection>

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
