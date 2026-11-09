<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
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
  import AccountConfigNotices from "#lib/features/computers/AccountConfigNotices.svelte";
  import AnimatedMascotsSetting from "#lib/features/bots/components/AnimatedMascotsSetting.svelte";
  import InterfaceSettings from "#lib/features/settings/InterfaceSettings.svelte";
  import TypographySettings from "#lib/features/settings/TypographySettings.svelte";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { devicePreferences, appearanceDeviceKeys } from "#lib/features/settings/device-preferences.svelte.ts";
  import { setAnimatedMascots } from "#lib/features/bots/animated-mascots.ts";

  const settings = useSettings();
  const scheme = $derived(schemeOf(settings.appearance));
  const chatWidth = $derived(chatWidthOf(settings.appearance));
  const schemes = ["system", "light", "dark"] as const;
</script>

<svelte:head><title>Appearance · Settings · {applicationName}</title></svelte:head>

<div class="mb-4 flex justify-end">
  <Button
    size="sm"
    icon="arrow-path"
    onclick={() => {
      devicePreferences.reset(appearanceDeviceKeys);
      setAnimatedMascots(true);
    }}>Restore device defaults</Button
  >
</div>

<SettingsGroup title="Colors" description="Account">
  <PreferenceRow
    title="Color scheme"
    description="Follow the system or use a fixed light or dark palette."
    changed={scheme !== "system"}
    onreset={() => settings.updateAppearance({ colorScheme: schemeNames.system })}
  >
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
  </PreferenceRow>
</SettingsGroup>

<ThemePicker />

<SettingsGroup title="Interface" description="This device unless marked Account">
  <InterfaceSettings />
  <AnimatedMascotsSetting />
  <PreferenceRow
    title="Thread width"
    description="Set the width of threads and their message boxes."
    changed={chatWidth !== "comfortable"}
    onreset={() => settings.updateAppearance({ chatWidth: chatWidthNames.comfortable })}
  >
    {#snippet control()}
      <Badge>Account</Badge>
      <Select
        name="chatWidth"
        aria-label="Thread width"
        value={chatWidth}
        onchange={(value) => settings.updateAppearance({ chatWidth: chatWidthNames[value as ChatWidthName] })}
        class="w-40"
        options={Object.entries(chatWidthLabels).map(([value, label]) => ({ value, label }))}
      />
    {/snippet}
  </PreferenceRow>
</SettingsGroup>

<TypographySettings />

<AccountConfigNotices section="appearance" />
