<script lang="ts">
  import Select from "#lib/shared/ui/Select.svelte";
  import PreferenceRow from "./PreferenceRow.svelte";
  import { useSettings } from "./settings-state.svelte.ts";
  import {
    cornerChoices,
    isCorner,
    isSpacing,
    spacingChoices,
    themeCustomizationDefaults,
    themeOptionsOf,
  } from "./theme-customization.ts";

  /** Shape applies to every theme, so light and dark can use different themes with the same corners and spacing. */
  const settings = useSettings();
  const options = $derived(themeOptionsOf(settings.appearance));
</script>

<PreferenceRow
  title="Corner radius"
  description="Rounds the corners of controls, cards, and dialogs."
  changed={options.cornerRadius !== themeCustomizationDefaults.cornerRadius}
  onreset={() => settings.updateAppearance({ cornerRadius: themeCustomizationDefaults.cornerRadius })}
>
  {#snippet control()}
    <Select
      aria-label="Corner radius"
      class="w-40"
      options={cornerChoices}
      value={options.cornerRadius}
      onchange={(value) => {
        if (isCorner(value)) settings.updateAppearance({ cornerRadius: value });
      }}
    />
  {/snippet}
</PreferenceRow>
<PreferenceRow
  title="Spacing"
  description="Sets the padding of messages, sidebar threads, and settings."
  changed={options.spacing !== themeCustomizationDefaults.spacing}
  onreset={() => settings.updateAppearance({ spacing: themeCustomizationDefaults.spacing })}
>
  {#snippet control()}
    <Select
      aria-label="Spacing"
      class="w-40"
      options={spacingChoices}
      value={options.spacing}
      onchange={(value) => {
        if (isSpacing(value)) settings.updateAppearance({ spacing: value });
      }}
    />
  {/snippet}
</PreferenceRow>
