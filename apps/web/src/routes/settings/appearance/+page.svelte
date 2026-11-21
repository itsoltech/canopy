<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import {
    chatWidthOf,
    namesOf,
    schemeChoices,
    schemeOf,
    themeOf,
    widthChoices,
  } from "#lib/features/settings/appearance.ts";
  import { colorSchemePreference, threadWidthPreference } from "@canopy/domain";
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
  const schemes = namesOf(schemeChoices);
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

<SettingsGroup title={colorSchemePreference.group} description="Account">
  <PreferenceRow
    title={colorSchemePreference.label}
    changed={scheme !== colorSchemePreference.defaultChoice}
    onreset={() => settings.updateAppearance({ colorScheme: schemeChoices[colorSchemePreference.defaultChoice].value })}
  >
    {#snippet control()}
      <div class="grid w-80 max-w-full grid-cols-3 gap-2" role="radiogroup" aria-label={colorSchemePreference.label}>
        {#each schemes as mode (mode)}
          <OptionTile
            checked={scheme === mode}
            label={schemeChoices[mode].label}
            onchange={() => settings.updateAppearance({ colorScheme: schemeChoices[mode].value })}
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
            <div class="text-center font-medium">{schemeChoices[mode].label}</div>
          </OptionTile>
        {/each}
      </div>
    {/snippet}
  </PreferenceRow>
</SettingsGroup>

<ThemePicker />

<SettingsGroup title={threadWidthPreference.group} description="This device unless marked Account">
  <InterfaceSettings />
  {#if settings.moduleEnabled("bots")}<AnimatedMascotsSetting />{/if}
  {#if settings.moduleEnabled("threads")}
    <PreferenceRow
      title={threadWidthPreference.label}
      description={threadWidthPreference.description}
      changed={chatWidth !== threadWidthPreference.defaultChoice}
      onreset={() => settings.updateAppearance({ chatWidth: widthChoices[threadWidthPreference.defaultChoice].value })}
    >
      {#snippet control()}
        <Badge>Account</Badge>
        <Select
          name="chatWidth"
          aria-label={threadWidthPreference.label}
          value={chatWidth}
          onchange={(value) => {
            const choice = namesOf(widthChoices).find((name) => name === value);
            if (choice) settings.updateAppearance({ chatWidth: widthChoices[choice].value });
          }}
          class="w-40"
          options={namesOf(widthChoices).map((value) => ({ value, label: widthChoices[value].label }))}
        />
      {/snippet}
    </PreferenceRow>
  {/if}
</SettingsGroup>

<TypographySettings />

<AccountConfigNotices section="appearance" />
