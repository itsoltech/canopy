<script lang="ts">
  import PreferenceRow from "./PreferenceRow.svelte";
  import { devicePreferences as device } from "./device-preferences.svelte.ts";
  import Slider from "#lib/shared/ui/Slider.svelte";
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
