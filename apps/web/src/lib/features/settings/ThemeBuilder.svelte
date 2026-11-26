<script lang="ts">
  import { isThemeName, themeNames, themes, themeVariables, type ThemeMode } from "@canopy/ui/themes";
  import {
    decodeThemeBuilderPatch,
    packThemeColors,
    themeTokenNames,
    type ThemeTokenName,
  } from "@canopy/ui/theme-builder";
  import { randomizeThemeColors } from "@canopy/ui/theme-random";
  import { hexLuminance } from "@canopy/ui/color";
  import Button from "#lib/shared/ui/Button.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import SegmentedChoice from "#lib/shared/ui/SegmentedChoice.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { colorThemes, namesOf, schemeChoices, themeOf } from "./appearance.ts";
  import { useSettings } from "./settings-state.svelte.ts";
  import { useSettingsRoute } from "./settings-route.ts";
  import { useSettingsThemePreview } from "./settings-theme-preview.ts";
  import {
    accentOf,
    cornerChoices,
    editThemeColors,
    isAccent,
    isCorner,
    isSpacing,
    spacingChoices,
    themeOptionsOf,
    themeOverridesOf,
    type ColorEdits,
    type ThemeOptions,
  } from "./theme-customization.ts";
  import ThemeColorsEditor from "./ThemeColorsEditor.svelte";

  const settings = useSettings();
  const route = useSettingsRoute();
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

  let mode = $state<ThemeMode>("light");
  let previewVersion = $state("draft");
  let edits = $state.raw<Partial<Omit<ThemeOptions, "lightColors" | "darkColors">>>({});
  const emptyEdits: Record<ThemeMode, ColorEdits> = { light: {}, dark: {} };
  let colorEdits = $state.raw(emptyEdits);
  let seenProposal: string | null = null;

  const applied = $derived(themeOptionsOf(settings.appearance));

  const preview = $derived({
    ...applied,
    ...edits,
    lightColors: editThemeColors(applied.lightColors, colorEdits.light),
    darkColors: editThemeColors(applied.darkColors, colorEdits.dark),
  });

  const changed = $derived(
    namesOf(applied).some((key) => key !== "lightColors" && key !== "darkColors" && preview[key] !== applied[key]) ||
      packThemeColors(preview.lightColors) !== packThemeColors(applied.lightColors) ||
      packThemeColors(preview.darkColors) !== packThemeColors(applied.darkColors),
  );

  const palette = $derived(themeOf(preview, mode));
  const accentKey = $derived(mode === "light" ? "lightAccent" : "darkAccent");
  const modeLabel = $derived(schemeChoices[mode].label);
  const overrides = $derived(mode === "light" ? preview.lightColors : preview.darkColors);

  const palettesForPreview = $derived({
    light: themeVariables(themeOf(preview, "light"), "light", themeOverridesOf(preview, "light")),
    dark: themeVariables(themeOf(preview, "dark"), "dark", themeOverridesOf(preview, "dark")),
  });

  const colors = $derived(palettesForPreview[mode]);
  const showingApplied = $derived(changed && previewVersion === "applied");

  const previewVersions = $derived([
    { value: "draft", label: "Draft" },
    { value: "applied", label: "Applied", disabled: !changed },
  ]);

  const sampleOptions = $derived(showingApplied ? applied : preview);

  const contrast = (fg: string, bg: string) => {
    const a = hexLuminance(fg);
    const b = hexLuminance(bg);

    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  const contrastWarnings = $derived(
    modes
      .flatMap(({ value, label }) => {
        const c = palettesForPreview[value];

        const lowSurface = [c.canvas, c.surface, c.panel, c.hover].some(
          (bg) => contrast(c.ink, bg) < 4.5 || contrast(c.muted, bg) < 4.5 || contrast(c.accent, bg) < 3,
        );

        const lowAction = [c.action, c["action-hover"]].some((bg) => contrast(c["on-accent"], bg) < 4.5);

        return lowSurface || lowAction ? [label] : [];
      })
      .join(" and "),
  );

  $effect(() => {
    const encoded = route.url.searchParams.get("theme");

    if (!encoded) {
      seenProposal = null;

      return;
    }

    if (encoded !== seenProposal) {
      seenProposal = encoded;
      stageProposal(encoded);
    }

    void route.consumeQuery("theme");
  });

  function stageProposal(encoded: string) {
    const patch = decodeThemeBuilderPatch(encoded);

    if (!patch) {
      toast("Could not open this theme. Ask for a new theme link.", { tone: "error" });
    } else {
      const { light, dark, ...shape } = patch;
      edits = shape;
      colorEdits = { light: light ?? {}, dark: dark ?? {} };
      mode = dark && !light ? "dark" : "light";
      previewVersion = "draft";
    }
  }

  export function discard() {
    edits = {};
    colorEdits = emptyEdits;
    previewVersion = "draft";
  }

  function editColor(token: ThemeTokenName, color: string | undefined) {
    colorEdits = { ...colorEdits, [mode]: { ...colorEdits[mode], [token]: color ?? null } };
  }

  function resetColors() {
    colorEdits = { ...colorEdits, [mode]: Object.fromEntries(themeTokenNames.map((token) => [token, null])) };
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
    if (!settings.updateAppearance({ ...edits, lightColors: preview.lightColors, darkColors: preview.darkColors }))
      return;

    discard();
    toast("Theme applied");
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
        bind:value={() => (showingApplied ? "applied" : "draft"), (value) => (previewVersion = value)}
        class="[&_button]:min-h-(--settings-target) [&_button:disabled]:opacity-50"
      />
      {@render colorSchemePicker("Preview color scheme")}
    </div>
  </div>
{/snippet}

<div class="builder grid min-w-0 grid-cols-1 gap-(--settings-section-gap)">
  <SettingsGroup title="Theme options">
    {#snippet actions()}{@render colorSchemePicker("Color scheme to edit")}{/snippet}
    <div class="@container p-(--settings-row-x)">
      <div class="grid min-w-0 gap-3 @min-[19rem]:grid-cols-2">
        <Field label="{modeLabel} palette">
          <Select
            aria-label="{modeLabel} palette"
            options={palettes}
            value={palette}
            onchange={(value) => {
              if (isThemeName(value)) {
                edits = { ...edits, [mode === "light" ? "lightTheme" : "darkTheme"]: colorThemes[value] };
              }
            }}
          />
        </Field>
        <Field label="{modeLabel} accent preset">
          <Select
            aria-label="{modeLabel} accent preset"
            options={accents}
            value={preview[accentKey]}
            onchange={(value) => {
              if (isAccent(value)) edits = { ...edits, [accentKey]: value };
            }}
          >
            {#snippet leading(option)}
              {@const accent = isAccent(option.value) ? accentOf({ [accentKey]: option.value }, mode) : undefined}
              <span
                class="size-3.5 shrink-0 rounded-full border border-divider"
                style:background={themeVariables(palette, mode, { accent }).accent}
                aria-hidden="true"
              ></span>
            {/snippet}
          </Select>
        </Field>
        <Field label="Corner radius">
          <Select
            aria-label="Corner radius"
            options={cornerChoices}
            value={preview.cornerRadius}
            onchange={(value) => {
              if (isCorner(value)) edits = { ...edits, cornerRadius: value };
            }}
          />
        </Field>
        <Field label="Spacing">
          <Select
            aria-label="Spacing"
            options={spacingChoices}
            value={preview.spacing}
            onchange={(value) => {
              if (isSpacing(value)) edits = { ...edits, spacing: value };
            }}
          />
        </Field>
      </div>
    </div>
  </SettingsGroup>
  {#if contrastWarnings}
    <p class="min-w-0 px-1 text-sm/5 text-amber-700 dark:text-amber-400" role="status">
      Draft contrast is low in {contrastWarnings}. Check the text, accent, and button colors.
    </p>
  {/if}
  <SettingsGroup title="{modeLabel} colors">
    {#snippet actions()}
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={!Object.keys(overrides).length} onclick={resetColors}
          >Reset colors</Button
        >
        <Button size="sm" onclick={() => (colorEdits = randomizeThemeColors())}>Randomize both palettes</Button>
      </div>
    {/snippet}
    <div class="p-(--settings-row-x)">
      <ThemeColorsEditor values={colors} {overrides} onchange={editColor} />
    </div>
  </SettingsGroup>
</div>

<div
  data-theme-builder-actions
  class="builder-actions sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t border-divider py-2"
>
  <Button
    size="sm"
    icon="eye"
    disabled={!themePreviewHost.available}
    onclick={(event) => startPreview(event.currentTarget)}>Preview in app</Button
  >
  <div class="ml-auto flex flex-wrap justify-end gap-2">
    <Button size="sm" variant="ghost" disabled={!changed} onclick={discard}>Discard changes</Button>
    <Button size="sm" variant="primary" disabled={!changed} onclick={save}>Apply theme</Button>
  </div>
</div>

<style>
  .builder :global(.settings-group-header) {
    align-items: center;
  }

  .builder :global(.settings-group-header > :last-child) {
    max-width: 100%;
  }

  .builder-actions {
    background: light-dark(var(--color-white), var(--color-zinc-950));
  }
</style>
