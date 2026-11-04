<script lang="ts">
  import {
    chatWidthLabels,
    chatWidthNames,
    chatWidthOf,
    schemeLabels,
    schemeNames,
    schemeOf,
    themeOf,
    type ChatWidthName,
  } from "#lib/features/settings/appearance.ts";
  import ThemePreview from "#lib/features/settings/ThemePreview.svelte";
  import ThemePicker from "#lib/features/settings/ThemePicker.svelte";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import OptionTile from "#lib/shared/ui/OptionTile.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import ShareSetting from "#lib/features/computers/ShareSetting.svelte";
  import SharingGroup from "#lib/features/computers/SharingGroup.svelte";
  import { sharedKey } from "@canopy/domain/computers";
  import AnimatedMascotsSetting from "#lib/features/bots/components/AnimatedMascotsSetting.svelte";

  const settings = useSettings();
  const scheme = $derived(schemeOf(settings.appearance));
  const chatWidth = $derived(chatWidthOf(settings.appearance));
  const schemes = ["system", "light", "dark"] as const;
</script>

<svelte:head><title>Appearance · Settings · Canopy</title></svelte:head>

<SettingsGroup>
  <SettingsRow title="Color scheme" description="Follow this device or always use your light or dark palette.">
    {#snippet control()}
      <div class="grid w-80 max-w-full grid-cols-3 gap-2" role="radiogroup" aria-label="Color scheme">
        {#each schemes as mode (mode)}
          <OptionTile
            checked={scheme === mode}
            label={schemeLabels[mode]}
            onchange={() => settings.updateAppearance({ colorScheme: schemeNames[mode] })}
            class="grid gap-2 p-2"
          >
            <div class="relative overflow-hidden rounded-lg">
              <ThemePreview
                theme={themeOf(settings.appearance, mode === "dark" ? "dark" : "light")}
                mode={mode === "dark" ? "dark" : "light"}
              />
              {#if mode === "system"}<div class="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
                  <ThemePreview theme={themeOf(settings.appearance, "dark")} mode="dark" />
                </div>{/if}
            </div>
            <div class="text-center font-medium">{schemeLabels[mode]}</div>
          </OptionTile>
        {/each}
      </div>
    {/snippet}
  </SettingsRow>
</SettingsGroup>

<ThemePicker />

<SettingsGroup title="Interface">
  <AnimatedMascotsSetting />
  <SettingsRow title="Chat width" description="How wide the conversation and the message box are.">
    {#snippet control()}
      <Select
        name="chatWidth"
        aria-label="Chat width"
        value={chatWidth}
        onchange={(value) => settings.updateAppearance({ chatWidth: chatWidthNames[value as ChatWidthName] })}
        class="w-40"
        options={Object.entries(chatWidthLabels).map(([value, label]) => ({ value, label }))}
      />
    {/snippet}
  </SettingsRow>
</SettingsGroup>

<SharingGroup>
  <ShareSetting
    itemKey={sharedKey.settings("appearance")}
    label="Appearance"
    local="Color scheme, light and dark themes, and chat width. Panel and sidebar layout stay on each computer."
  />
</SharingGroup>
