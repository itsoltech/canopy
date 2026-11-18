<script lang="ts">
  import { useSettings } from "./settings-state.svelte.ts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
  import { devicePreferences as device } from "./device-preferences.svelte.ts";
  import Slider from "#lib/shared/ui/Slider.svelte";

  const settings = useSettings();
</script>

<PreferenceRow
  title="Contrast"
  description="Strengthen muted text and borders in both color schemes."
  changed={device.values.contrast !== "standard"}
  onreset={() => device.set("contrast", "standard")}
>
  {#snippet control()}<div class="w-64 max-w-full">
      <Slider
        label="Interface contrast"
        value={device.values.contrast}
        steps={[
          { value: "standard", label: "Standard" },
          { value: "strong", label: "Strong" },
          { value: "maximum", label: "Maximum" },
        ]}
        onchange={(v) => device.set("contrast", v)}
      />
    </div>{/snippet}
</PreferenceRow>
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
