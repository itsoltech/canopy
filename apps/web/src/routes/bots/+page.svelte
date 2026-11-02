<script lang="ts">
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { onMount } from "svelte";
  import { goto, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import { create } from "@bufbuild/protobuf";
  import { bots, ui } from "@open-agents/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { botWizardInstances } from "#lib/features/bots/live.ts";
  import CreateBotWizard, { type CreateBotDraft } from "#lib/features/bots/wizard/CreateBotWizard.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  let instances = $state.raw<ui.ProviderInstance[]>([]);
  let existing = $state.raw<bots.Bot[]>([]);
  let open = $state(false);
  let loaded = $state(false);
  let error = $state("");
  const catalogs = useModelCatalog();
  const options = $derived(botWizardInstances(instances, [...catalogs.workers.values()]));
  const requestId = crypto.randomUUID();
  $effect(() => {
    if (loaded && page.url.searchParams.get("create") === "1") {
      open = true;
      replaceState("/bots", page.state);
    }
  });
  onMount(() => {
    void Promise.all([requestJson("GET", "/api/providers"), requestJson("GET", "/api/bots")]).then(([providers, list]) => {
      instances = decode(ui.ListProviderInstancesResponseSchema, providers).instances;
      existing = decode(bots.ListBotsResponseSchema, list).bots;
      loaded = true;
    }).catch(() => { error = "Could not load bots and provider instances"; });
  });
  async function oncreate(result: CreateBotDraft) {
    const instance = instances.find((i) => instanceKeyOf(i) === result.providerInstanceId);
    if (!instance) throw new Error("Provider instance is no longer available");
    const response = decode(bots.GetBotResponseSchema, await requestJson("POST", "/api/bots", encode(bots.CreateBotRequestSchema, create(bots.CreateBotRequestSchema, {
      clientRequestId: requestId, configuration: {
        name: result.name, shape: result.shape, color: result.color, provider: instance.harness,
        providerInstance: instance.id, model: result.model, effort: result.effort ?? "", approvalPolicy: "safe",
      },
    }))));
    window.dispatchEvent(new Event("bots-changed"));
    await goto(`/bots/${response.bot!.id}`);
  }
</script>

<svelte:head><title>Bots · Open Agents</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar><Crumb>Bots</Crumb></TopBar>
  <div class="grid min-h-0 flex-1 place-content-center gap-4 overflow-y-auto p-6 text-center">
    <h1 class="text-xl font-semibold">Your bots</h1>
    <p class="max-w-md text-sm text-zinc-500">A conversation with a bot that remembers your messages and can work with your connected services and agents.</p>
    {#if error}<p role="alert" class="text-sm text-red-500">{error}</p>{/if}
    <Button variant="primary" disabled={!loaded} onclick={() => (open = true)}>Create bot</Button>
    {#if loaded && (!options.length || options.every((i) => !i.models.length))}
      <p class="max-w-md text-sm text-zinc-500">Add an endpoint provider and models in <a href="/settings/providers" class="underline">Settings → Providers</a>. Custom model IDs also work without a connected worker.</p>
    {/if}
  </div>
</div>
<CreateBotWizard bind:open instances={options} existingNames={existing.map((b) => b.configuration?.name ?? "")} {oncreate} />
