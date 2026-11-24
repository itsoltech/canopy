<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import AnimatedMascotsSetting from "#lib/features/bots/components/AnimatedMascotsSetting.svelte";
  import ContrastSetting from "#lib/features/settings/ContrastSetting.svelte";
  import DeviceChoiceRow from "#lib/features/settings/DeviceChoiceRow.svelte";
  import DiffColorsSetting from "#lib/features/settings/DiffColorsSetting.svelte";
  import InterfaceSizeSetting from "#lib/features/settings/InterfaceSizeSetting.svelte";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";

  const settings = useSettings();
</script>

<svelte:head><title>Accessibility · Settings · {applicationName}</title></svelte:head>

<SettingsGroup title="This device">
  <DeviceChoiceRow
    preference="focusIndicators"
    title="Focus indicators"
    description="Choose when to outline the active control."
    options={[
      { value: "keyboard", label: "Keyboard only" },
      { value: "always", label: "Always" },
      { value: "off", label: "Off" },
    ]}
  />
  <ContrastSetting />
  <InterfaceSizeSetting />
  {#if settings.moduleEnabled("threads")}<DiffColorsSetting />{/if}
  {#if settings.moduleEnabled("bots")}<AnimatedMascotsSetting />{/if}
</SettingsGroup>
