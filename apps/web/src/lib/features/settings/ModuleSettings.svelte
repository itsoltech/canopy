<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { moduleChoices, moduleSettingsDescription } from "@canopy/ui/settings";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import PreferenceRow from "./PreferenceRow.svelte";
  import { useSettings } from "./settings-state.svelte.ts";

  let { class: className }: { class?: ClassValue } = $props();
  const settings = useSettings();

  const options = $derived(
    moduleChoices.map((module) => ({ ...module, disabled: !settings.moduleEnabled(module.value) })),
  );

  const first = $derived(settings.enabledModules[0]);

  function setFirst(value: string) {
    const module = moduleChoices.find((item) => item.value === value)?.value;

    if (module) void settings.setFirstModule(module);
  }
</script>

<SettingsGroup title="Modules" description={moduleSettingsDescription} class={className}>
  <PreferenceRow
    title="First tab"
    description="Canopy opens this tab by default."
    changed={first !== "threads" && settings.moduleEnabled("threads")}
    onreset={() => settings.setFirstModule("threads")}
  >
    {#snippet control()}
      <SegmentedChoice
        label="First tab"
        bind:value={() => first, setFirst}
        {options}
        disabled={!settings.loaded || settings.enabledModules.length === 1}
      />
    {/snippet}
  </PreferenceRow>
  {#each moduleChoices as module (module.value)}
    {@const enabled = settings.moduleEnabled(module.value)}
    {@const last = enabled && settings.enabledModules.length === 1}
    <PreferenceRow
      title={module.label}
      description={last ? `Turn on ${module.other} before turning off ${module.label}.` : module.description}
      changed={!enabled}
      onreset={() => settings.setModuleEnabled(module.value, true)}
    >
      {#snippet control()}
        <Switch
          name={module.value}
          label={module.label}
          checked={enabled}
          disabled={last || !settings.loaded}
          onchange={(on) => settings.setModuleEnabled(module.value, on)}
        />
      {/snippet}
    </PreferenceRow>
  {/each}
</SettingsGroup>
