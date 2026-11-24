<script lang="ts">
  import { supportsIsolatedRuns } from "@canopy/domain/harnesses";
  import { automaticTextGenerationDescription } from "@canopy/ui/providers";
  import { Provider } from "@canopy/contracts";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import { modelOption, modelOptions, type ModelOption } from "#lib/features/models/catalog.ts";
  import { useModelCatalog } from "#lib/features/models/model-catalog.svelte.ts";
  import SettingsModelControls from "#lib/features/models/SettingsModelControls.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { providerKeyOf } from "#lib/features/threads/providers.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import SettingAction from "#lib/shared/ui/SettingAction.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { useSettings } from "./settings-state.svelte.ts";

  const settings = useSettings();
  const overview = useOverview();
  const catalog = useModelCatalog();
  const value = $derived(settings.textGeneration);

  const options = $derived([
    ...new Map(
      overview.ownWorkers
        .flatMap((worker) =>
          modelOptions({ worker, catalog: catalog.of(worker.id), threads: overview.threads.values() }).filter(
            (o) => o.model && supportsIsolatedRuns(Provider[o.provider]),
          ),
        )
        .map((o) => [o.key, o]),
    ).values(),
  ]);

  const provider = $derived(providerKeyOf(value.provider));
  const profileId = $derived(value.profileId === "native" ? "" : value.profileId);

  const worker = $derived(
    overview.ownWorkers.find((w) =>
      w.providerInstances.some(
        (i) => i.harness === value.provider && i.id === (profileId || "native") && i.available && i.enabled,
      ),
    ),
  );

  const option = $derived(
    value.model && provider
      ? (options.find((o) => o.provider === provider && o.profileId === profileId && o.model === value.model) ??
          modelOption(
            provider,
            profileId,
            profileId || "Device login",
            value.model,
            worker ? catalog.of(worker.id) : undefined,
          ))
      : undefined,
  );

  function select(next: ModelOption | undefined) {
    if (!next) return;
    void settings.updateTextGeneration({
      provider: Provider[next.provider],
      profileId: next.profileId,
      model: next.model,
      effort: next.efforts.some((e) => e.id === "low") ? "low" : "",
    });
  }
</script>

<SettingsTopics
  label="Text generation settings"
  topics={[
    { id: "model", label: "Model", content: model },
    { id: "title-instructions", label: "Title instructions", content: instructions },
  ]}
/>

{#snippet model()}
  <SettingsGroup title="Text generation model" description="Account">
    {#snippet actions()}
      <Button
        size="sm"
        icon="arrow-path"
        disabled={!value.model}
        onclick={() =>
          settings.updateTextGeneration({ provider: Provider.UNSPECIFIED, profileId: "", model: "", effort: "" })}
        >Reset to default</Button
      >
    {/snippet}
    <SettingsRow title="Model and effort" description="Generate thread titles and branch names with this model.">
      <div class="grid min-w-0 gap-2 pt-3">
        <SettingsModelControls
          {options}
          bind:option={() => option, select}
          bind:effort={
            () => value.effort || undefined, (effort) => void settings.updateTextGeneration({ effort: effort ?? "" })
          }
          workerId={worker?.id}
          resetLabel="Reset text generation effort to default"
        />
        {#if !value.model}
          <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
            {automaticTextGenerationDescription}
          </p>
        {/if}
      </div>
    </SettingsRow>
  </SettingsGroup>
{/snippet}

{#snippet instructions()}
  <SettingsGroup title="Thread titles" description="Account">
    {#snippet actions()}
      <SettingAction active={!!value.threadTitleInstructions}>
        <Button
          size="sm"
          icon="arrow-path"
          onclick={() => settings.updateTextGeneration({ threadTitleInstructions: "" })}
        >
          Reset instructions
        </Button>
      </SettingAction>
    {/snippet}
    <div class="p-4">
      <Field label="Thread title instructions" description="Add guidance for new and regenerated thread titles.">
        <Textarea
          name="threadTitleInstructions"
          rows={3}
          maxlength={4000}
          value={value.threadTitleInstructions}
          placeholder="Keep titles to a few words. Lead with the main subject."
          onchange={(event) => settings.updateTextGeneration({ threadTitleInstructions: event.currentTarget.value })}
        />
      </Field>
    </div>
  </SettingsGroup>
{/snippet}
