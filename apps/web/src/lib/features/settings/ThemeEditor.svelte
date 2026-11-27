<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { isThemeName, themeNames, themes, themeVariables, type ThemeMode } from "@canopy/ui/themes";
  import type { ThemeTokenName } from "@canopy/ui/theme-builder";
  import { randomizeThemeColors } from "@canopy/ui/theme-random";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { colorThemes, schemeChoices, themeOf } from "./appearance.ts";
  import { useSettings } from "./settings-state.svelte.ts";
  import { useSettingsThemePreview } from "./settings-theme-preview.ts";
  import {
    accentOf,
    cornerChoices,
    editThemeColors,
    isAccent,
    spacingChoices,
    themeOptionsOf,
    themeOverridesOf,
    type ThemeOptions,
    type WebAppearance,
  } from "./theme-customization.ts";
  import {
    customChoice,
    followTheme,
    modeKeys,
    sameColorOptions,
    uniqueThemeName,
    type CustomTheme,
  } from "./custom-themes.ts";
  import { customThemes } from "./custom-themes.svelte.ts";
  import { hasLowContrast } from "./theme-contrast.ts";
  import type { ThemeEditing } from "./theme-proposal.svelte.ts";
  import ThemeColorsEditor from "./ThemeColorsEditor.svelte";
  import DeleteThemeButton from "./DeleteThemeButton.svelte";

  /**
   * Edits one custom theme. `created`: the theme is not in the library yet, and saving it also chooses it for
   * both color schemes. `shape`: corner radius and spacing from a bot proposal, applied with the theme.
   */
  let {
    theme,
    created,
    shape = {},
    mode: initialMode = "light",
    onclose,
  }: ThemeEditing & { onclose: () => void } = $props();

  const settings = useSettings();
  const themePreviewHost = useSettingsThemePreview();
  const modes = (["light", "dark"] as const).map((value) => ({ value, label: schemeChoices[value].label }));
  const palettes = themeNames.map((value) => ({ value, label: themes[value].label }));

  const accents = [
    { value: "palette", label: "Palette default" },
    { value: "neutral", label: "Neutral" },
    { value: "blue", label: "Blue" },
    { value: "emerald", label: "Green" },
    { value: "sky", label: "Sky" },
    { value: "orange", label: "Orange" },
    { value: "violet", label: "Violet" },
    { value: "pink", label: "Pink" },
  ] as const;

  let mode = $state<ThemeMode>(untrack(() => initialMode));
  let previewVersion = $state("draft");
  let draft = $state.raw<CustomTheme>(untrack(() => theme));
  let name = $state(untrack(() => theme.name));
  let root = $state<HTMLDivElement>();

  onMount(() => {
    root?.scrollIntoView({ block: "nearest" });
    root?.querySelector<HTMLInputElement>('input[name="theme-name"]')?.focus({ preventScroll: true });
  });

  const keys = $derived(modeKeys[mode]);
  const modeLabel = $derived(schemeChoices[mode].label);
  const palette = $derived(themeOf(draft, mode));
  const overrides = $derived(draft[keys.colors]);
  const applied = $derived(themeOptionsOf(settings.appearance));
  const reshaped = $derived(Object.keys(shape).length > 0);

  const changed = $derived(created || reshaped || name !== theme.name || !sameColorOptions(draft, theme));

  const draftOptions = $derived<ThemeOptions>({
    ...draft,
    cornerRadius: shape.cornerRadius ?? applied.cornerRadius,
    spacing: shape.spacing ?? applied.spacing,
  });

  const variables = $derived({
    light: themeVariables(themeOf(draft, "light"), "light", themeOverridesOf(draft, "light")),
    dark: themeVariables(themeOf(draft, "dark"), "dark", themeOverridesOf(draft, "dark")),
  });

  const current = $derived(sameColorOptions(draft, applied) && !reshaped);
  const showingCurrent = $derived(!current && previewVersion === "current");

  const previewVersions = $derived([
    { value: "draft", label: "Draft" },
    { value: "current", label: "Current", disabled: current },
  ]);

  const sampleOptions = $derived(showingCurrent ? applied : draftOptions);

  const contrastWarnings = $derived(
    modes.flatMap(({ value, label }) => (hasLowContrast(variables[value]) ? [label] : [])).join(" and "),
  );

  const shapeNote = $derived(
    [
      shape.cornerRadius &&
        `corner radius to ${cornerChoices.find((choice) => choice.value === shape.cornerRadius)?.label}`,
      shape.spacing && `spacing to ${spacingChoices.find((choice) => choice.value === shape.spacing)?.label}`,
    ]
      .filter(Boolean)
      .join(" and "),
  );

  function editColor(token: ThemeTokenName, color: string | undefined) {
    draft = { ...draft, [keys.colors]: editThemeColors(draft[keys.colors], { [token]: color ?? null }) };
  }

  function startPreview(opener: HTMLButtonElement) {
    previewVersion = "draft";
    themePreviewHost.start({
      opener,
      controls: windowPreviewControls,
      get options() {
        return sampleOptions;
      },
      get mode() {
        return mode;
      },
    });
  }

  function save() {
    const others = customThemes.list.filter((candidate) => candidate.id !== draft.id);
    const saved: CustomTheme = { ...draft, name: name.trim() || uniqueThemeName(others) };

    if (!customThemes.save(saved)) return;

    const change: Partial<WebAppearance> = {
      ...shape,
      ...(created
        ? { ...customChoice("light", saved), ...customChoice("dark", saved) }
        : followTheme(settings.appearance, saved)),
    };

    if (Object.keys(change).length && !settings.updateAppearance(change)) return;
    toast(created ? "Theme created" : "Theme saved");
    onclose();
  }
</script>

{#snippet colorSchemePicker(label: string)}
  <SegmentedChoice
    {label}
    options={modes}
    bind:value={
      () => mode,
      (value) => {
        if (value === "light" || value === "dark") mode = value;
      }
    }
    class="[&_button]:min-h-(--settings-target)"
  />
{/snippet}

{#snippet windowPreviewControls(exit: () => void)}
  <div class="mx-auto flex max-w-(--settings-content-width) flex-wrap items-center justify-between gap-2 px-4 py-2">
    <Button
      size="sm"
      icon="arrow-left"
      variant="ghost"
      aria-label="Back to editor"
      data-exit-theme-preview
      onclick={exit}><span class="sm:hidden">Back</span><span class="hidden sm:inline">Back to editor</span></Button
    >
    <div class="flex flex-wrap gap-2">
      <SegmentedChoice
        label="Preview version"
        options={previewVersions}
        bind:value={() => (showingCurrent ? "current" : "draft"), (value) => (previewVersion = value)}
        class="[&_button]:min-h-(--settings-target) [&_button:disabled]:opacity-50"
      />
      {@render colorSchemePicker("Preview color scheme")}
    </div>
  </div>
{/snippet}

<div bind:this={root} class="editor grid min-w-0 scroll-mt-4 grid-cols-1 gap-(--settings-section-gap)">
  <div class="-my-1">
    <Button size="sm" variant="ghost" icon="arrow-left" onclick={onclose}>Themes</Button>
  </div>
  <SettingsGroup title={created ? "New theme" : "Edit theme"}>
    {#snippet actions()}{@render colorSchemePicker("Color scheme to edit")}{/snippet}
    <div class="@container p-(--settings-row-x)">
      <div class="grid min-w-0 gap-3 @min-[19rem]:grid-cols-2">
        <div class="col-span-full">
          <Field label="Name">
            <Input name="theme-name" maxlength={48} bind:value={name} placeholder={theme.name} />
          </Field>
        </div>
        <Field label="{modeLabel} base palette">
          <Select
            aria-label="{modeLabel} base palette"
            options={palettes}
            value={palette}
            onchange={(value) => {
              if (isThemeName(value)) draft = { ...draft, [keys.theme]: colorThemes[value] };
            }}
          />
        </Field>
        <Field label="{modeLabel} accent preset">
          <Select
            aria-label="{modeLabel} accent preset"
            options={accents}
            value={draft[keys.accent]}
            onchange={(value) => {
              if (isAccent(value)) draft = { ...draft, [keys.accent]: value };
            }}
          >
            {#snippet leading(option)}
              {@const accent = isAccent(option.value) ? accentOf({ [keys.accent]: option.value }, mode) : undefined}
              <span
                class="size-3.5 shrink-0 rounded-full border border-divider"
                style:background={themeVariables(palette, mode, { accent }).accent}
                aria-hidden="true"
              ></span>
            {/snippet}
          </Select>
        </Field>
      </div>
    </div>
  </SettingsGroup>
  {#if shapeNote}
    <p class="min-w-0 px-1 text-sm/5 text-muted">
      Saving this theme also sets {shapeNote}.
    </p>
  {/if}
  {#if contrastWarnings}
    <p class="min-w-0 px-1 text-sm/5 text-amber-700 dark:text-amber-400" role="status">
      Draft contrast is low in {contrastWarnings}. Check the text, accent, and button colors.
    </p>
  {/if}
  <SettingsGroup title="{modeLabel} colors">
    {#snippet actions()}
      <div class="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!Object.keys(overrides).length}
          onclick={() => (draft = { ...draft, [keys.colors]: {} })}>Reset colors</Button
        >
        <Button
          size="sm"
          onclick={() => {
            const random = randomizeThemeColors();
            draft = { ...draft, lightColors: random.light, darkColors: random.dark };
          }}>Randomize both palettes</Button
        >
      </div>
    {/snippet}
    <div class="p-(--settings-row-x)">
      <ThemeColorsEditor values={variables[mode]} {overrides} onchange={editColor} />
    </div>
  </SettingsGroup>
</div>

<div
  data-theme-builder-actions
  class="editor-actions sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t border-divider py-2"
>
  <Button
    size="sm"
    icon="eye"
    disabled={!themePreviewHost.available}
    onclick={(event) => startPreview(event.currentTarget)}>Preview in app</Button
  >
  {#if !created}<DeleteThemeButton {theme} ondeleted={onclose} />{/if}
  <div class="ml-auto flex flex-wrap justify-end gap-2">
    <Button size="sm" variant="ghost" onclick={onclose}>Cancel</Button>
    <Button size="sm" variant="primary" disabled={!changed} onclick={save}
      >{created ? "Create theme" : "Save theme"}</Button
    >
  </div>
</div>

<style>
  .editor :global(.settings-group-header) {
    align-items: center;
  }

  .editor :global(.settings-group-header > :last-child) {
    max-width: 100%;
  }

  .editor-actions {
    background: light-dark(var(--color-white), var(--color-zinc-950));
  }
</style>
