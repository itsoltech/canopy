<script lang="ts">
  import { Provider, type ui } from "@canopy/contracts";
  import { modelKey, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import SettingsModelControls from "#lib/features/models/SettingsModelControls.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import {
    instanceLabel,
    instanceOf,
    profileIdValue,
    providerKeyOf,
    providerName,
  } from "#lib/features/threads/providers.ts";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { habitModelOptions } from "./habit-model-options.ts";

  let {
    models,
    draft = $bindable(),
    valid = $bindable(false),
    disabled,
  }: {
    models: ui.MemoryReflectionModel[];
    draft: ui.MemoryReflectionSettings;
    valid?: boolean;
    disabled: boolean;
  } = $props();

  const overview = useOverview();
  const catalog = useModelCatalog();
  const options = $derived(habitModelOptions(models, overview.ownWorkers, catalog.workers));
  const provider = $derived(providerKeyOf(draft.provider));
  const profileId = $derived(profileIdValue(draft.profileId));
  const key = $derived(provider && modelKey(provider, profileId, draft.model));
  const option = $derived(options.find((item) => item.key === key));
  const effortValid = $derived(!draft.effort || option?.efforts.some((level) => level.id === draft.effort));

  const missingSelection = $derived.by(() => {
    if (!provider || option) return undefined;
    const instance = overview.ownWorkers.map((worker) => instanceOf(worker, provider, profileId)).find((item) => item);
    const label = instanceLabel(instance ?? { id: profileId || "native", label: "" });

    return `${draft.model || "Auto"} · ${providerName(provider)} · ${label}`;
  });

  const description = $derived.by(() => {
    if (!options.length) return "Connect a worker with a signed-in provider, then refresh habits.";

    if (missingSelection) return "This model is unavailable. Choose another model.";

    if (draft.enabled && !provider) return "Choose a model to turn on habit checks.";

    if (!effortValid) return "This reasoning effort is unavailable. Reset it to Auto.";

    if (option && !option.model) return "Auto uses a small model from this provider profile.";

    return undefined;
  });

  $effect(() => {
    valid = !!option && !!effortValid;
  });

  function select(next: ModelOption | undefined) {
    if (!next || next.key === key) return;
    draft = {
      ...draft,
      provider: Provider[next.provider],
      profileId: next.profileId || "native",
      model: next.model,
      effort: "",
    };
  }
</script>

<SettingsRow title="Habit check model" {description}>
  <div class="min-w-0 pt-3">
    <SettingsModelControls
      {options}
      bind:option={() => option, select}
      bind:effort={() => draft.effort || undefined, (effort) => (draft = { ...draft, effort: effort ?? "" })}
      {missingSelection}
      resetLabel="Reset reasoning effort to Auto"
      automaticEffort
      disabled={disabled || !options.length}
    />
  </div>
</SettingsRow>
