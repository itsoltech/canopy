<script lang="ts">
  import ContrastSetting from "#lib/features/settings/ContrastSetting.svelte";
  import { useSettings } from "./settings-state.svelte.ts";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";

  const settings = useSettings();
</script>

<ContrastSetting />
<DeviceChoiceRow
  preference="seasonalAccents"
  title="Seasonal accents"
  description="Show seasonal decorations on the tree in the sidebar."
  options={[
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ]}
/>
<DeviceChoiceRow
  preference="effortDisplay"
  title="Effort display"
  description="Show reasoning effort as names or bars in model controls."
  options={[
    { value: "name", label: "Name" },
    { value: "bars", label: "Bars" },
  ]}
/>
{#if settings.moduleEnabled("threads")}
  <DeviceChoiceRow
    preference="contextDisplay"
    title="Context display"
    description="Show the latest reported context use in every thread's message box on this device."
    options={[
      { value: "off", label: "Off" },
      { value: "circle", label: "Circle" },
      { value: "text", label: "Text" },
      { value: "bar", label: "Bar" },
      { value: "percentage", label: "Percentage" },
    ]}
  />
{/if}
<DeviceChoiceRow
  preference="renderMath"
  title="Render math"
  description="Show LaTeX formulas in messages and previews."
  options={[
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ]}
/>
{#if settings.moduleEnabled("threads")}
  <DeviceChoiceRow
    preference="fileLinks"
    title="Open files in"
    description="Where a file path in an agent's message opens when you click it. Files on another computer open in Canopy."
    options={[
      { value: "canopy", label: "Canopy" },
      { value: "app", label: "Default app" },
    ]}
  />
{/if}
