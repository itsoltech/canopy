<script lang="ts">
  import { themeColorGroups, themeTokenLabel, type ThemeColors, type ThemeTokenName } from "@canopy/ui/theme-builder";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import ThemeColorField from "./ThemeColorField.svelte";

  let {
    values,
    overrides,
    onchange,
  }: {
    values: Readonly<Record<ThemeTokenName, string>>;
    overrides: ThemeColors;
    onchange: (token: ThemeTokenName, value: string | undefined) => void;
  } = $props();

  const [semantic, ...shades] = themeColorGroups;
  const summaryClass = "min-h-(--settings-target) px-2 py-1.5 text-base/5 font-medium hover:bg-hover";
</script>

{#snippet colorGrid(tokens: readonly ThemeTokenName[], group?: string)}
  <ul class="color-grid m-0 grid list-none gap-x-2 p-0">
    {#each tokens as token (token)}
      <li class="min-w-0">
        <ThemeColorField
          label={themeTokenLabel(token)}
          {group}
          value={values[token]}
          overridden={overrides[token] !== undefined}
          onchange={(value) => onchange(token, value)}
        />
      </li>
    {/each}
  </ul>
{/snippet}

<div class="grid min-w-0 gap-2">
  {#if semantic}{@render colorGrid(semantic.tokens)}{/if}
  <Disclosure align="center" {summaryClass} class="border-t border-divider pt-1">
    {#snippet summary()}Advanced shades{/snippet}
    <div class="grid min-w-0 gap-1 ps-2">
      {#each shades as group (group.label)}
        <Disclosure align="center" {summaryClass}>
          {#snippet summary()}{group.label}{/snippet}
          {@render colorGrid(group.tokens, group.label)}
        </Disclosure>
      {/each}
    </div>
  </Disclosure>
</div>

<style>
  .color-grid {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
  }
</style>
