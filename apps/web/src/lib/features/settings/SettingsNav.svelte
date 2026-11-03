<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import { settingsGroups, settingsSections as sharedSections } from "./sections.ts";
  import { onMount } from "svelte";
  import type { SettingsSection } from "@canopy/ui/settings";
  let desktop = $state(false);
  onMount(() => { desktop = Boolean(window.canopyDesktop); });
  const settingsSections = $derived<readonly SettingsSection[]>(desktop ? [...sharedSections, { href: "/settings/desktop", label: "Desktop", icon: "server", group: "Connections", keywords: "desktop local remote worker computer" }] : sharedSections);
  import { useSettingsRoute } from "./settings-route.ts";
  import { CANOPY_VERSION } from "@canopy/domain/release/version";

  /** Settings sections with a search filter (T3 style); a scrolling row on narrow screens. */
  let query = $state("");
  const visible = $derived(
    settingsSections.filter((s) => !query.trim() || `${s.label} ${s.keywords}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const route = useSettingsRoute();
  const active = (href: string) => route.url.pathname === href || route.url.pathname.startsWith(`${href}/`);
  const itemClass =
    "flex shrink-0 items-center gap-2.5 rounded-lg whitespace-nowrap px-2.5 py-2 text-base/6 text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring aria-[current=page]:bg-zinc-950/5 aria-[current=page]:text-zinc-950 sm:py-1.5 sm:text-sm/6 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:bg-white/8 dark:aria-[current=page]:text-white";
</script>

<nav aria-label="Settings" class="grid grid-cols-1 gap-3">
  <SearchField label="Search settings" name="settings-search" data-autofocus bind:value={query} placeholder="Search" class="max-lg:hidden" />

  <ul role="list" class="flex gap-1 overflow-x-auto lg:hidden">
    {#each settingsSections as section (section.href)}
      <li><a href={section.href} class={itemClass} aria-current={active(section.href) ? "page" : undefined}><Icon name={section.icon} class="fill-current" />{section.label}</a></li>
    {/each}
  </ul>

  <div class="grid grid-cols-1 gap-5 max-lg:hidden">
    {#each settingsGroups as group (group)}
      {@const items = visible.filter((s) => s.group === group)}
      {#if items.length > 0}
        <div>
          <h2 class="px-2.5 text-sm/6 text-zinc-500 sm:text-xs/6">{group}</h2>
          <ul role="list" class="mt-1 grid gap-0.5">
            {#each items as section (section.href)}
              <li><a href={section.href} class={itemClass} aria-current={active(section.href) ? "page" : undefined}><Icon name={section.icon} class="fill-current" />{section.label}</a></li>
            {/each}
          </ul>
        </div>
      {/if}
    {:else}
      <p class="px-2.5 text-sm/6 text-zinc-500">No setting matches “{query}”.</p>
    {/each}
    <p class="px-2.5 text-xs/6 text-zinc-500 tabular-nums">Canopy {CANOPY_VERSION}</p>
  </div>
</nav>
