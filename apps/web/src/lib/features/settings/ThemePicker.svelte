<script lang="ts">
  import { themeNames, themes, type ThemeMode } from "@canopy/ui/themes";
  import { useSettings } from "./settings-state.svelte.ts";
  import { builtinChoice, choiceOf, customChoice, type CustomTheme, type ThemeChoice } from "./custom-themes.ts";
  import { customThemes } from "./custom-themes.svelte.ts";
  import OptionTile from "#lib/shared/ui/OptionTile.svelte";
  import ThemePreview from "./ThemePreview.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ResettableControl from "#lib/shared/ui/ResettableControl.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import CustomThemeTile from "./CustomThemeTile.svelte";

  /** `onedit` and `oncreate` open the theme editor on the color scheme of the column they came from. */
  let {
    onedit,
    oncreate,
  }: { onedit: (theme: CustomTheme, mode: ThemeMode) => void; oncreate: (mode: ThemeMode) => void } = $props();

  const settings = useSettings();
  const modes: ThemeMode[] = ["light", "dark"];
  const modeLabel = (mode: ThemeMode) => (mode === "light" ? "Light" : "Dark");

  const choices = $derived({
    light: choiceOf(settings.appearance, "light", customThemes.list),
    dark: choiceOf(settings.appearance, "dark", customThemes.list),
  });

  const labelOf = (choice: ThemeChoice) => (choice.kind === "custom" ? choice.theme.name : themes[choice.name].label);
</script>

<SettingsGroup title="Themes">
  <div class="@container p-(--settings-row-x)">
    <div class="grid grid-cols-2 gap-3 sm:gap-4">
      {#each modes as mode (mode)}
        {@const choice = choices[mode]}
        <div role="radiogroup" aria-label="{modeLabel(mode)} theme" class="grid content-start gap-2 @2xl:grid-cols-2">
          <div
            class="col-span-full flex min-w-0 items-center justify-between gap-2 text-base/6 font-medium sm:text-sm/6"
          >
            <p>{modeLabel(mode)}</p>
            <ResettableControl changed={choice.kind === "custom" || choice.name !== "birch"} align="end">
              <p class="truncate text-muted">{labelOf(choice)}</p>
              {#snippet reset()}<IconButton
                  icon="arrow-path"
                  size="sm"
                  label="Reset {mode} theme to default"
                  onclick={() => settings.updateAppearance(builtinChoice(mode, "birch"))}
                />{/snippet}
            </ResettableControl>
          </div>
          {#each themeNames as name (name)}
            <OptionTile
              checked={choice.kind === "builtin" && choice.name === name}
              label="{themes[name].label}, {mode} theme"
              onchange={() => settings.updateAppearance(builtinChoice(mode, name))}
              class="grid gap-1 p-1.5"
            >
              <ThemePreview theme={name} {mode} />
              <div class="px-0.5 font-medium wrap-anywhere">{themes[name].label}</div>
            </OptionTile>
          {/each}
          {#each customThemes.list as theme (theme.id)}
            <CustomThemeTile
              {theme}
              {mode}
              checked={choice.kind === "custom" && choice.theme.id === theme.id}
              onchange={() => settings.updateAppearance(customChoice(mode, theme))}
              onedit={() => onedit(theme, mode)}
            />
          {/each}
          <button
            type="button"
            data-new-theme={mode}
            class="new-theme grid min-h-20 place-content-center justify-items-center gap-1.5 rounded-xl p-1.5 text-base/6 font-medium text-muted focus-ring sm:text-sm/6"
            onclick={() => oncreate(mode)}
          >
            <span class="plus grid size-8 place-items-center rounded-full"><Icon name="plus" tone="inherit" /></span>
            New theme
          </button>
        </div>
      {/each}
    </div>
  </div>
  <p class="sr-only" role="status">Light: {labelOf(choices.light)}. Dark: {labelOf(choices.dark)}.</p>
</SettingsGroup>

<style>
  .new-theme {
    border: 1px dashed var(--color-divider);
    transition-property: color, border-color, background-color;
    transition-duration: var(--duration-quick);
    transition-timing-function: var(--ease-smooth-out);
  }

  .new-theme:hover {
    color: var(--color-ink);
    border-color: var(--color-accent);
    background: color-mix(in oklab, var(--color-accent) 6%, transparent);
  }

  .plus {
    background: var(--color-hover);
    transition: scale var(--duration-fast) var(--ease-spring);
  }

  .new-theme:hover .plus {
    scale: 1.1;
  }

  @media (prefers-reduced-motion: reduce) {
    .new-theme,
    .plus {
      transition: none;
    }
  }
</style>
