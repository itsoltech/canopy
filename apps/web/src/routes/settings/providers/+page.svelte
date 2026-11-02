<script lang="ts">
  import { ui } from "@open-agents/contracts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import AddInstanceDialog from "#lib/features/providers/AddInstanceDialog.svelte";
  import InstanceDetail from "#lib/features/providers/InstanceDetail.svelte";
  import InstanceRow from "#lib/features/providers/InstanceRow.svelte";
  import { instanceKeyOf, instanceName, providerCall } from "#lib/features/providers/instances.ts";
  import { ProvidersState } from "#lib/features/providers/providers-state.svelte.ts";
  import ScopeBar from "#lib/features/providers/ScopeBar.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import { pageSlide } from "#lib/shared/ui/motion.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  /**
   * Settings → Providers (T3 layout): provider instances defined once in the gateway and synced to the workers you
   * choose. The scope bar picks where changes apply (all workers or one); the list beside the detail on wide screens,
   * list → detail on phones. Data comes from this page's load and its own calls (the page works as an overlay too).
   */
  let { data }: PageProps = $props();
  const overview = useOverview();
  const catalog = useModelCatalog();
  // svelte-ignore state_referenced_locally (seeded once; the page keeps it current itself)
  const providers = new ProvidersState({
    instances: decode(ui.ListProviderInstancesResponseSchema, data.instances).instances,
    catalogs: decode(ui.ListModelsResponseSchema, data.models).workers,
  });

  let scope = $state<string>();
  let selectedKey = $state<string>();
  /** Phones show one pane: the list, or the selected instance. */
  let pane = $state<"list" | "detail">("list");
  let adding = $state(false);
  let toggling = $state<string>();
  let failure = $state<string>();

  const workers = $derived(overview.workers);
  const worker = $derived(workers.find((w) => w.id === scope));
  const selected = $derived(providers.find(selectedKey) ?? providers.instances[0]);

  // A worker that reports again (applied a configuration, connected, went away): the instances' state follows.
  const reports = $derived(workers.map((w) => `${w.id}:${w.online}:${w.appliedVersion}:${w.configVersion}`).join(","));
  let seenReports: string | undefined;
  $effect(() => {
    const current = reports;
    if (seenReports !== undefined && seenReports !== current) void providers.reload().catch(() => {});
    seenReports = current;
  });
  // New model lists (after a configuration or a refresh): the full catalogs again.
  const listed = $derived([...catalog.workers.values()].map((c) => `${c.workerId}:${c.updatedAt?.seconds ?? 0}`).join(","));
  let seenListed: string | undefined;
  $effect(() => {
    const current = listed;
    if (seenListed !== undefined && seenListed !== current) void providers.reloadModels().catch(() => {});
    seenListed = current;
  });

  function select(key: string) {
    selectedKey = key;
    pane = "detail";
  }

  async function toggle(instance: ui.ProviderInstance, enabled: boolean) {
    if (!worker) return;
    toggling = instanceKeyOf(instance);
    failure = undefined;
    try {
      providers.put((await providerCall("worker", { harness: instance.harness, id: instance.id, workerId: worker.id, enabled })).instance);
      toast(`${instanceName(instance)} turned ${enabled ? "on" : "off"} on ${worker.name}`);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      await providers.reload().catch(() => {});
    } finally {
      toggling = undefined;
    }
  }

  async function refresh() {
    failure = undefined;
    try {
      await providers.refresh();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }
</script>

<svelte:head><title>Providers · Settings · Open Agents</title></svelte:head>

<SettingsHeading title="Providers" description="Agent harnesses and how they reach their models. Defined once, synced to the workers you choose.">
  {#snippet actions()}
    <span class="text-sm/5 text-zinc-500 max-sm:hidden dark:text-zinc-400" role="status">
      {providers.refreshing ? "Checking…" : providers.checkedAt ? "Checked just now" : ""}
    </span>
    <Button icon="arrow-path" loading={providers.refreshing} onclick={refresh}>Refresh</Button>
    <Button variant="primary" icon="plus" onclick={() => (adding = true)}>Add</Button>
  {/snippet}
</SettingsHeading>

<div class="grid grid-cols-1 gap-4">
  <ScopeBar {workers} bind:scope />
  {#if failure}<Alert tone="error">{failure}</Alert>{/if}
  {#if providers.skipped.length > 0}<Alert tone="info">Not checked: {providers.skipped.join("; ")}</Alert>{/if}
  {#if worker && !worker.online}<Alert tone="info">{worker.name} is offline. Changes are saved and reach it when it connects.</Alert>{/if}

  <div class="grid grid-cols-1 gap-6 md:grid-cols-[16rem_minmax(0,1fr)] md:items-start">
    <nav aria-label="Provider instances" class={["md:sticky md:top-0", pane === "detail" && "max-md:hidden"]}>
      <InsetList>
        {#each providers.instances as instance (instanceKeyOf(instance))}
          <li>
            <InstanceRow
              {instance}
              {worker}
              selected={selected !== undefined && instanceKeyOf(selected) === instanceKeyOf(instance)}
              busy={toggling === instanceKeyOf(instance)}
              onselect={() => select(instanceKeyOf(instance))}
              ontoggle={(enabled) => toggle(instance, enabled)}
            />
          </li>
        {/each}
      </InsetList>
    </nav>

    <div class={["grid min-w-0 grid-cols-1", pane === "list" && "max-md:hidden"]}>
      {#if selected}
        {#key `${instanceKeyOf(selected)}:${scope ?? ""}`}
          <div class="col-start-1 row-start-1 grid min-w-0 grid-cols-1 gap-4" in:pageSlide>
            <button
              type="button"
              class="-ml-1 flex items-center gap-1 justify-self-start rounded-md px-1 text-base/6 text-zinc-600 hover:text-zinc-950 focus-ring md:hidden dark:text-zinc-400 dark:hover:text-white"
              onclick={() => (pane = "list")}>← All providers</button
            >
            <InstanceDetail instance={selected} {worker} {workers} state={providers} ondeleted={() => ((selectedKey = undefined), (pane = "list"))} />
          </div>
        {/key}
      {/if}
    </div>
  </div>
</div>

<AddInstanceDialog
  bind:open={adding}
  instances={providers.instances}
  {workers}
  {scope}
  onadded={(instance) => {
    providers.put(instance);
    if (instance) select(instanceKeyOf(instance));
    toast(`${instance ? instanceName(instance) : "Instance"} added`);
  }}
/>
