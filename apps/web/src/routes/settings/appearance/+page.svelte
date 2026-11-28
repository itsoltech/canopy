<script lang="ts">
  import { tick } from "svelte";
  import { motionSettingsKeywords } from "@canopy/ui/settings";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import { applicationName } from "#lib/application-name.ts";
  import {
    chatWidthOf,
    namesOf,
    schemeChoices,
    schemeOf,
    themeOf,
    widthChoices,
  } from "#lib/features/settings/appearance.ts";
  import { colorSchemePreference, deviceAppearanceDefaults, threadWidthPreference } from "@canopy/domain";
  import ThemePreview from "#lib/features/settings/ThemePreview.svelte";
  import ThemePicker from "#lib/features/settings/ThemePicker.svelte";
  import ThemeEditor from "#lib/features/settings/ThemeEditor.svelte";
  import { colorOptionsOf, newCustomTheme } from "#lib/features/settings/custom-themes.ts";
  import { customThemes } from "#lib/features/settings/custom-themes.svelte.ts";
  import ThemeShapeSettings from "#lib/features/settings/ThemeShapeSettings.svelte";
  import { themeCustomizationDefaults, themeOverridesOf } from "#lib/features/settings/theme-customization.ts";
  import { useThemeProposal, type ThemeEditing } from "#lib/features/settings/theme-proposal.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import OptionTile from "#lib/shared/ui/OptionTile.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import MotionSettings from "#lib/features/settings/MotionSettings.svelte";
  import InterfaceSettings from "#lib/features/settings/InterfaceSettings.svelte";
  import TypographySettings from "#lib/features/settings/TypographySettings.svelte";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { devicePreferences, appearanceDeviceKeys } from "#lib/features/settings/device-preferences.svelte.ts";
  import { setAnimatedMascots } from "#lib/features/bots/animated-mascots.ts";

  const settings = useSettings();
  const scheme = $derived(schemeOf(settings.appearance));
  const chatWidth = $derived(chatWidthOf(settings.appearance));
  const schemes = namesOf(schemeChoices);
  let editing = $state<ThemeEditing>();

  /** Focus returns to the pencil of the edited theme, or to New theme after a cancel or delete. */
  async function closeEditor() {
    const id = editing?.theme.id ?? "";
    const mode = editing?.mode ?? "light";
    editing = undefined;
    await tick();

    const opener =
      document.querySelector<HTMLElement>(`[data-edit-theme="${CSS.escape(id)}"]`) ??
      document.querySelector<HTMLElement>(`[data-new-theme="${mode}"]`);

    opener?.focus();
  }

  useThemeProposal((proposal) => (editing = proposal));
</script>

<svelte:head><title>Appearance · Settings · {applicationName}</title></svelte:head>

<div class="flex flex-wrap items-center justify-between gap-2">
  <p class="text-sm/5 text-muted">Appearance preferences stay on this device.</p>
  <Button
    size="sm"
    icon="arrow-path"
    onclick={() => {
      settings.updateAppearance({ ...deviceAppearanceDefaults, ...themeCustomizationDefaults });
      editing = undefined;
      devicePreferences.reset(appearanceDeviceKeys);
      setAnimatedMascots(true);
    }}>Reset appearance</Button
  >
</div>

<SettingsTopics
  label="Appearance settings"
  topics={[
    {
      id: "themes",
      label: "Themes",
      keywords: "custom theme new edit builder editor color palette accent",
      content: themes,
    },
    {
      id: "interface",
      label: "Interface",
      keywords: "corner radius rounding rounded spacing density compact spacious",
      content: interfaceOptions,
    },
    { id: "typography", label: "Typography", content: typography },
    {
      id: "motion",
      label: "Motion",
      keywords: motionSettingsKeywords,
      content: motion,
    },
  ]}
/>

{#snippet themes()}
  {#if editing}
    {#key editing}
      <ThemeEditor {...editing} onclose={closeEditor} />
    {/key}
  {:else}
    {@render themeChoices()}
  {/if}
{/snippet}

{#snippet themeChoices()}
  <SettingsGroup title={colorSchemePreference.group}>
    <PreferenceRow
      title={colorSchemePreference.label}
      changed={scheme !== colorSchemePreference.defaultChoice}
      onreset={() =>
        settings.updateAppearance({ colorScheme: schemeChoices[colorSchemePreference.defaultChoice].value })}
    >
      {#snippet control()}
        <div class="grid w-80 max-w-full grid-cols-3 gap-2" role="radiogroup" aria-label={colorSchemePreference.label}>
          {#each schemes as mode (mode)}
            {@const paletteMode = mode === "dark" ? "dark" : "light"}
            <OptionTile
              checked={scheme === mode}
              label={schemeChoices[mode].label}
              onchange={() => settings.updateAppearance({ colorScheme: schemeChoices[mode].value })}
              class="grid gap-2 p-2"
            >
              <div class="relative overflow-hidden rounded-lg">
                <ThemePreview
                  theme={themeOf(settings.appearance, paletteMode)}
                  mode={paletteMode}
                  overrides={themeOverridesOf(settings.appearance, paletteMode)}
                />
                {#if mode === "system"}<div class="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
                    <ThemePreview
                      theme={themeOf(settings.appearance, "dark")}
                      mode="dark"
                      overrides={themeOverridesOf(settings.appearance, "dark")}
                    />
                  </div>{/if}
              </div>
              <div class="text-center font-medium">{schemeChoices[mode].label}</div>
            </OptionTile>
          {/each}
        </div>
      {/snippet}
    </PreferenceRow>
  </SettingsGroup>

  <ThemePicker
    onedit={(theme, mode) => (editing = { theme, created: false, mode })}
    oncreate={(mode) =>
      (editing = {
        theme: newCustomTheme(customThemes.list, colorOptionsOf(settings.appearance)),
        created: true,
        mode,
      })}
  />
{/snippet}

{#snippet interfaceOptions()}
  <SettingsGroup title={threadWidthPreference.group}>
    <InterfaceSettings />
    <ThemeShapeSettings />
    {#if settings.moduleEnabled("threads")}
      <PreferenceRow
        title={threadWidthPreference.label}
        description="Applies to threads, their message boxes, pull requests, and Markdown previews in file tabs."
        changed={chatWidth !== threadWidthPreference.defaultChoice}
        onreset={() =>
          settings.updateAppearance({ chatWidth: widthChoices[threadWidthPreference.defaultChoice].value })}
      >
        {#snippet control()}
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
{/snippet}

{#snippet typography()}
  <TypographySettings />
{/snippet}

{#snippet motion()}
  <MotionSettings />
{/snippet}
