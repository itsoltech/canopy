<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { Provider, ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ModelSelection from "#lib/features/profiles/ModelSelection.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import { profileName, saveSelection } from "#lib/features/profiles/profiles.ts";
  import { providerLabel } from "#lib/features/threads/labels.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import { formatRelative } from "#lib/shared/format.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { segmentedItem, segmentedTrack } from "#lib/shared/ui/segmented.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const route = useSettingsRoute();
  const overview = useOverview();

  const workerId = $derived(route.params.workerId ?? "");
  const worker = $derived(overview.worker(workerId));
  const provider = $derived(data.provider === "claude" ? Provider.CLAUDE : Provider.CODEX);
  const profile = $derived(decode(ui.ListProviderProfilesResponseSchema, data.profiles).profiles.find((p) => p.id === data.profileId)!);
  const catalog = $derived(
    decode(ui.ListModelsResponseSchema, data.models)
      .workers.find((w) => w.workerId === workerId)
      ?.profiles.find((p) => p.provider === provider && p.profileId === profile.id),
  );
  const models = $derived(catalog?.models ?? []);
  const hiddenByProvider = $derived(new Set(models.filter((m) => m.hidden).map((m) => m.id)));
  const selection = $derived(profile.modelSelections.find((s) => s.provider === provider));
  const name = $derived(providerLabel(provider));

  let refreshing = $state(false);
  let refreshError = $state<string>();
  const tab = (key: "claude" | "codex") => `/settings/workers/${workerId}/models?profile=${encodeURIComponent(profile.id)}&provider=${key}`;
  const request = (init: { shown?: string[]; known?: string[]; showNew?: boolean; showAll?: boolean }) => create(ui.SetModelSelectionRequestSchema, { workerId, profileId: profile.id, provider, ...init });

  async function refresh() {
    refreshing = true;
    refreshError = undefined;
    try {
      // The worker lists again (it must be online); it can take a while with a slow proxy.
      await requestJson("POST", "/api/models", { workerId }, 100_000);
      await route.refresh("app:profiles");
    } catch (error) {
      refreshError = error instanceof Error ? error.message : String(error);
    } finally {
      refreshing = false;
    }
  }
</script>

<svelte:head><title>{name} models · {profileName(profile)} · Settings · Open Agents</title></svelte:head>

<div class="grid gap-4">
  <SettingsHeading
    title="{name} models"
    description="Which models of {profileName(profile)} on {worker?.name ?? 'this worker'} appear in the model pickers. Threads already on a hidden model keep it."
  >
    {#snippet actions()}<ButtonLink href="/settings/workers/{workerId}" size="sm" icon="arrow-left">Profiles</ButtonLink>{/snippet}
  </SettingsHeading>

  <div class="flex flex-wrap items-center justify-between gap-3">
    {#if profile.providers.length > 1}
      <nav aria-label="Agent" class={["inline-flex", segmentedTrack]}>
        {#each ["claude", "codex"] as const as key (key)}
          <a href={tab(key)} class={segmentedItem} data-active={data.provider === key || undefined} aria-current={data.provider === key ? "page" : undefined}>
            {key === "claude" ? "Claude" : "Codex"}
          </a>
        {/each}
      </nav>
    {/if}
    <div class="flex min-w-0 items-center gap-3 sm:ml-auto">
      {#if catalog?.listedAt}<p class="truncate text-sm/5 text-zinc-500 dark:text-zinc-400">Listed {formatRelative(catalog.listedAt)}</p>{/if}
      <Button size="sm" icon="arrow-path" loading={refreshing} disabled={!worker?.online} onclick={refresh}>Refresh list</Button>
    </div>
  </div>

  {#if !worker?.online}<Alert tone="info">The worker is offline: this is its last list. Refresh once it is back.</Alert>{/if}
  {#if refreshError}<Alert tone="error">{refreshError}</Alert>{/if}
  {#if catalog?.detail}<Alert tone="warning" title="The list may be incomplete">{catalog.detail}</Alert>{/if}
</div>

<ModelSelection
  {models}
  {selection}
  providerName={name}
  {hiddenByProvider}
  onsave={async (shown, showNew) => {
    await saveSelection(request({ shown, known: models.map((m) => m.id), showNew }));
    toast("Model choice saved");
    await route.refresh("app:profiles");
  }}
  onreset={async () => {
    await saveSelection(request({ showAll: true }));
    toast("Showing the default list");
    await route.refresh("app:profiles");
  }}
/>
