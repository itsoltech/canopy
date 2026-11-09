<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import Crumb from "#lib/features/navigation/Crumb.svelte";
  import TopBar from "#lib/features/navigation/TopBar.svelte";
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { create } from "@bufbuild/protobuf";
  import { bots, ui } from "@canopy/contracts";
  import { requestJson } from "#lib/shared/http.ts";
  import { decode, encode } from "#lib/shared/wire.ts";
  import { instanceKeyOf } from "#lib/features/providers/instances.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { botWizardInstances } from "#lib/features/bots/live.ts";
  import CreateBotWizard, { type CreateBotDraft } from "#lib/features/bots/wizard/CreateBotWizard.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CenteredContent from "#lib/shared/ui/CenteredContent.svelte";

  const LOAD_ERROR = "Could not load bots and provider instances. Try again.";
  let instances = $state.raw<ui.ProviderInstance[]>([]);
  let existing = $state.raw<bots.Bot[]>([]);
  let open = $state(false);
  let loaded = $state(false);
  let error = $state("");
  let loading = $state(true);
  let request = 0;
  const overview = useOverview();
  const catalogs = useModelCatalog();

  const availableInstances = $derived([
    ...new Map(
      [
        ...instances,
        ...overview.workers.flatMap((worker) =>
          worker.providerInstances
            .filter((p) => !instances.some((i) => instanceKeyOf(i) === instanceKeyOf(p)))
            .map((p) =>
              create(ui.ProviderInstanceSchema, {
                harness: p.harness,
                id: p.id,
                label: p.label,
                kind: p.kind,
                accentColor: p.accentColor,
              }),
            ),
        ),
      ].map((i) => [instanceKeyOf(i), i]),
    ).values(),
  ]);

  const options = $derived(botWizardInstances(availableInstances, [...catalogs.workers.values()]));

  const status = $derived(
    error ? "error" : loading ? "loading" : loaded && options.every((i) => !i.models.length) ? "setup" : undefined,
  );

  const requestId = crypto.randomUUID();

  const availabilityVersion = $derived(
    `${overview.resyncs}:${overview.workers
      .map((worker) => `${worker.id}:${worker.configVersion}:${worker.appliedVersion}`)
      .join(",")}`,
  );

  $effect(() => {
    if (page.url.searchParams.get("create") !== "1") return;
    // SvelteKit's shallow replaceState updates page.state, not page.url. Reading that
    // state in this effect used to retrigger it forever while create=1 remained set.
    untrack(() => {
      openWizard();
      void goto("/bots", { replace: true, reset: false });
    });
  });

  async function refresh() {
    const current = ++request;
    loading = true;
    error = "";

    try {
      const [providers, list] = await Promise.all([
        requestJson("GET", "/api/providers"),
        requestJson("GET", "/api/bots"),
        catalogs.reload(),
      ]);

      if (current !== request) return;
      instances = decode(ui.ListProviderInstancesResponseSchema, providers).instances;
      existing = decode(bots.ListBotsResponseSchema, list).bots;
      loaded = true;
    } catch {
      if (current === request) error = LOAD_ERROR;
    } finally {
      if (current === request) loading = false;
    }
  }

  function openWizard() {
    open = true;
    void refresh();
  }

  onMount(() => {
    return overview.subscribe((update) => {
      if (update.change.case === "providerInstancesChanged") void refresh();
    });
  });

  $effect(() => {
    // ConfigApplied and configuration bumps invalidate availability, including older gateways.
    void availabilityVersion;
    untrack(() => void refresh());
  });

  async function oncreate(result: CreateBotDraft) {
    const instance = availableInstances.find((i) => instanceKeyOf(i) === result.providerInstanceId);

    if (!instance) throw new Error("Provider instance is no longer available");

    const response = decode(
      bots.GetBotResponseSchema,
      await requestJson(
        "POST",
        "/api/bots",
        encode(
          bots.CreateBotRequestSchema,
          create(bots.CreateBotRequestSchema, {
            clientRequestId: requestId,
            configuration: {
              name: result.name,
              shape: result.shape,
              color: result.color,
              provider: instance.harness,
              providerInstance: instance.id,
              workerId: result.workerId,
              model: result.model,
              effort: result.effort ?? "",
              approvalPolicy: "safe",
            },
          }),
        ),
      ),
    );

    window.dispatchEvent(new Event("bots-changed"));
    await goto(`/bots/${response.bot!.id}`);
  }
</script>

<svelte:head><title>Bots · {applicationName}</title></svelte:head>

<div class="flex h-full flex-col">
  <TopBar><Crumb>Bots</Crumb></TopBar>
  <CenteredContent class="max-w-md">
    <div class="grid gap-4 text-center">
      <h1 class="text-xl font-semibold">Your bots</h1>
      <p class="max-w-md text-sm text-zinc-500">
        A conversation with a bot that remembers your messages and can work with your connected services and agents.
      </p>
      <Button variant="primary" onclick={openWizard}>Create bot</Button>
      <!-- All statuses share one cell and reserve their wrapped height, including when it is empty. -->
      <div class="grid text-sm text-zinc-500">
        <p
          class={["col-start-1 row-start-1", status !== "loading" && "invisible"]}
          role="status"
          aria-hidden={status !== "loading"}
        >
          Loading providers and models…
        </p>
        <p class={["col-start-1 row-start-1", status !== "setup" && "invisible"]} aria-hidden={status !== "setup"}>
          Enable a provider instance on a worker in <a href="/settings/providers" class="underline"
            >Settings → Providers</a
          >.
        </p>
        <p
          class={["col-start-1 row-start-1 text-red-500", status !== "error" && "invisible"]}
          role="alert"
          aria-hidden={status !== "error"}
        >
          {error || LOAD_ERROR}
        </p>
      </div>
    </div>
  </CenteredContent>
</div>
<CreateBotWizard
  bind:open
  instances={options}
  {loading}
  loadError={error}
  onreload={() => void refresh()}
  existingNames={existing.map((b) => b.configuration?.name ?? "")}
  {oncreate}
/>
