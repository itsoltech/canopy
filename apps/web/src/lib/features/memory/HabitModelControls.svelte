<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import EffortPicker from "#lib/features/models/EffortPicker.svelte";
  import { effortLevel } from "#lib/features/models/catalog.ts";
  import type { ProviderKey } from "#lib/features/threads/providers.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import ResettableControl from "#lib/shared/ui/ResettableControl.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import HabitModelPicker from "./HabitModelPicker.svelte";

  let {
    models,
    model,
    effort,
    provider,
    profileAvailable,
    disabled,
    onmodel,
    oneffort,
  }: {
    models: ReadonlyMap<string, ui.MemoryReflectionModel>;
    model: string;
    effort: string;
    provider: ProviderKey | undefined;
    profileAvailable: boolean;
    disabled: boolean;
    onmodel: (id: string) => void;
    oneffort: (id: string) => void;
  } = $props();

  const selected = $derived(models.get(model));

  const effortOption = $derived(
    selected?.efforts.length && provider
      ? {
          provider,
          name: selected.label || selected.model,
          efforts: selected.efforts.map(effortLevel),
          defaultEffort: undefined,
        }
      : undefined,
  );

  const effortAvailable = $derived(effortOption?.efforts.some((option) => option.id === effort));
  const unavailable = $derived(disabled || !profileAvailable);
  let modelOpen = $state(false);
  let effortOpen = $state(false);

  const description = $derived.by(() => {
    if (!profileAvailable) return "Choose a provider profile first.";

    if (!model) return "Choose a specific model to set reasoning effort.";

    if (!selected) return "Choose an available model or use Auto.";

    if (effort && !effortAvailable) return "Reset reasoning effort to use Auto.";

    return effortOption ? undefined : "This model has no adjustable reasoning effort.";
  });

  $effect(() => {
    if (unavailable) modelOpen = false;

    if (unavailable || !effortOption) effortOpen = false;
  });
</script>

<SettingsRow title="Model and reasoning" {description}>
  <fieldset disabled={unavailable} class="min-w-0 pt-3">
    <ResettableControl changed={!!effort && !unavailable} align="start">
      <div class="flex min-w-0 items-center gap-1">
        <HabitModelPicker
          {models}
          value={model}
          {provider}
          bind:open={modelOpen}
          disabled={unavailable}
          onchange={onmodel}
        />
        {#if effortOption}
          <span class="shrink-0">
            <EffortPicker
              option={effortOption}
              bind:open={effortOpen}
              bind:value={() => (effortAvailable ? effort : undefined), (next) => oneffort(next ?? "")}
              onmodel={() => (modelOpen = true)}
              automatic
            />
          </span>
        {:else}
          <PillButton disabled class="shrink-0 pl-1.5 opacity-50">
            <Icon name="light-bulb" size="sm" />
            Reasoning effort
          </PillButton>
        {/if}
      </div>
      {#snippet reset()}
        <IconButton icon="arrow-path" label="Reset reasoning effort to Auto" size="sm" onclick={() => oneffort("")} />
      {/snippet}
    </ResettableControl>
  </fieldset>
</SettingsRow>
