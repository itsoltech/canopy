<script lang="ts">
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import MenuGroup from "#lib/shared/ui/MenuGroup.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import { sandboxProfileGroups, sandboxProfilesSettingsHref } from "../sandbox-profiles.ts";

  let {
    options,
    value,
    onselect,
  }: {
    options: readonly SelectOption[];
    value: string;
    onselect: (id: string) => void;
  } = $props();

  const groups = $derived(sandboxProfileGroups(options));
  const id = $props.id();
</script>

<MenuSeparator />
<MenuGroup label="Sandbox profile">
  {#each groups.available as option (option.value)}
    <MenuCheckItem checked={option.value === value} onselect={() => onselect(option.value)}>
      <span class="flex min-w-0 items-baseline gap-2">
        <span class="min-w-0 wrap-anywhere whitespace-normal">{option.label}</span>
        {#if option.value && option.description?.toLowerCase() !== option.label.toLowerCase()}
          <span class="ml-auto shrink-0 text-xs text-muted">{option.description}</span>
        {/if}
      </span>
    </MenuCheckItem>
  {/each}
</MenuGroup>
{#each groups.unavailable as [reason, profiles], index (reason)}
  <div role="group" aria-labelledby="{id}-{index}" class="mt-1 border-t border-divider pt-1">
    <p id="{id}-{index}" class="px-2 py-1 text-sm/5 text-pretty text-muted sm:text-xs/4">{reason}</p>
    {#each profiles as option (option.value)}
      <MenuCheckItem checked={option.value === value} disabled onselect={() => onselect(option.value)}>
        <span class="wrap-anywhere whitespace-normal">{option.label}</span>
      </MenuCheckItem>
    {/each}
  </div>
{/each}
<MenuSeparator />
<MenuItem href={sandboxProfilesSettingsHref}>Manage sandbox profiles</MenuItem>
