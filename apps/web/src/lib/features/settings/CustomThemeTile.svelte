<script lang="ts">
  import type { ThemeMode } from "@canopy/ui/themes";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import OptionTile from "#lib/shared/ui/OptionTile.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { themeOf } from "./appearance.ts";
  import type { CustomTheme } from "./custom-themes.ts";
  import { themeOverridesOf } from "./theme-customization.ts";
  import ThemePreview from "./ThemePreview.svelte";

  /**
   * A custom theme in the picker. The edit button sits beside the radio, not inside it, in the corner of the name
   * row; the name keeps room for it so a long name wraps instead of running under it.
   */
  let {
    theme,
    mode,
    checked,
    onchange,
    onedit,
  }: {
    theme: CustomTheme;
    mode: ThemeMode;
    checked: boolean;
    onchange: () => void;
    onedit: () => void;
  } = $props();
</script>

<div class="custom-tile relative grid min-w-0">
  <OptionTile {checked} label="{theme.name}, custom {mode} theme" {onchange} class="grid gap-1 p-1.5">
    <ThemePreview theme={themeOf(theme, mode)} {mode} overrides={themeOverridesOf(theme, mode)} />
    <div class="ps-0.5 pe-8 font-medium wrap-anywhere">{theme.name}</div>
  </OptionTile>
  <button
    type="button"
    class="edit absolute right-1.5 bottom-1.5 grid size-7 place-items-center rounded-full focus-ring"
    aria-label="Edit theme “{theme.name}”"
    data-edit-theme={theme.id}
    {@attach tooltip("Edit theme")}
    onclick={onedit}><Icon name="pencil-square" tone="inherit" class="pencil" /></button
  >
</div>

<style>
  .edit {
    color: var(--color-muted);
    background: color-mix(in oklab, var(--color-surface) 75%, transparent);
    box-shadow:
      0 0 0 1px var(--color-divider),
      0 1px 2px rgb(0 0 0 / 0.12);
    backdrop-filter: blur(6px);
    opacity: 0.75;
    scale: 0.92;
    transition-property: opacity, scale, color, background-color, box-shadow;
    transition-duration: var(--duration-quick);
    transition-timing-function: var(--ease-smooth-out);
  }

  .edit :global(.pencil) {
    transition: rotate var(--duration-fast) var(--ease-spring);
  }

  .custom-tile:hover .edit,
  .custom-tile:focus-within .edit {
    opacity: 1;
    scale: 1;
    transition-duration: var(--duration-fast);
    transition-timing-function: var(--ease-spring);
  }

  .edit:hover,
  .edit:focus-visible {
    color: var(--color-on-accent);
    background: var(--color-action);
    box-shadow: 0 2px 8px color-mix(in oklab, var(--color-action) 45%, transparent);
  }

  .edit:hover :global(.pencil) {
    rotate: -12deg;
  }

  @media (hover: none) {
    .edit {
      opacity: 1;
      scale: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .edit,
    .edit :global(.pencil) {
      transition: none;
      scale: 1;
      rotate: none;
    }
  }
</style>
