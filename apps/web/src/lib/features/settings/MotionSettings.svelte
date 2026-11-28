<script lang="ts">
  import AnimatedMascotsSetting from "#lib/features/bots/components/AnimatedMascotsSetting.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
  import ReduceMotionSetting from "./ReduceMotionSetting.svelte";
  import { useSettings } from "./settings-state.svelte.ts";

  const settings = useSettings();
</script>

<SettingsGroup>
  <DeviceChoiceRow
    preference="animations"
    title="Animations"
    description="Animate controls, menus, and panels."
    options={[
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ]}
  />
  <DeviceChoiceRow
    preference="animationSpeed"
    title="Animation speed"
    options={[
      { value: "fast", label: "Fast" },
      { value: "standard", label: "Standard" },
      { value: "slow", label: "Slow" },
    ]}
  />
  <ReduceMotionSetting />
  {#if settings.moduleEnabled("bots")}<AnimatedMascotsSetting />{/if}
</SettingsGroup>
