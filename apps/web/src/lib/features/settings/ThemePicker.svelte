<script lang="ts">
  import { themeNames, themes, type ThemeMode } from "@canopy/ui/themes";
  import { colorThemes, themeOf } from "./appearance.ts";
  import { useSettings } from "./settings-state.svelte.ts";
  import OptionTile from "#lib/shared/ui/OptionTile.svelte";
  import ThemePreview from "./ThemePreview.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ResettableControl from "#lib/shared/ui/ResettableControl.svelte";

  const settings = useSettings();
  const modes: ThemeMode[] = ["light", "dark"];
</script>

<SettingsGroup title="Themes" description="Account · Your color scheme decides which palette Canopy shows.">
  <div class="@container p-(--settings-row-x)">
    <div class="grid grid-cols-2 gap-3 sm:gap-4">
      {#each modes as mode (mode)}
        <div
          role="radiogroup"
          aria-label="{mode === 'light' ? 'Light' : 'Dark'} theme"
          class="grid content-start gap-2 @2xl:grid-cols-2"
        >
          <div
            class="col-span-full flex min-w-0 items-center justify-between gap-2 text-base/6 font-medium sm:text-sm/6"
          >
            <p>{mode === "light" ? "Light" : "Dark"}</p>
            <ResettableControl changed={themeOf(settings.appearance, mode) !== "birch"} align="end">
              <p class="truncate text-muted">{themes[themeOf(settings.appearance, mode)].label}</p>
              {#snippet reset()}<IconButton
                  icon="arrow-path"
                  size="sm"
                  label="Reset {mode} theme to default"
                  onclick={() =>
                    settings.updateAppearance(
                      mode === "light" ? { lightTheme: colorThemes.birch } : { darkTheme: colorThemes.birch },
                    )}
                />{/snippet}
            </ResettableControl>
          </div>
          {#each themeNames as name (name)}
            <OptionTile
              checked={themeOf(settings.appearance, mode) === name}
              label="{themes[name].label}, {mode} theme"
              onchange={() =>
                settings.updateAppearance(
                  mode === "light" ? { lightTheme: colorThemes[name] } : { darkTheme: colorThemes[name] },
                )}
              class="grid gap-1 p-1.5"
            >
              <ThemePreview theme={name} {mode} />
              <div class="px-0.5 font-medium wrap-anywhere">{themes[name].label}</div>
            </OptionTile>
          {/each}
        </div>
      {/each}
    </div>
  </div>
  <p class="sr-only" role="status">
    Light: {themes[themeOf(settings.appearance, "light")].label}. Dark: {themes[themeOf(settings.appearance, "dark")]
      .label}.
  </p>
</SettingsGroup>
