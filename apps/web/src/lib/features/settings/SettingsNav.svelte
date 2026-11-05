<script lang="ts">
  import { CANOPY_VERSION } from "@canopy/domain/release/version";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { settingsGroups } from "./sections.ts";
  import { useSettingsSections } from "./settings-sections.svelte.ts";

  /** Settings sections by group with a search filter; narrow screens use `SettingsSectionMenu`. */
  const sections = useSettingsSections();
  let query = $state("");

  const visible = $derived(
    sections.all.filter(
      (s) => !query.trim() || `${s.label} ${s.keywords}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  const itemClass =
    "flex min-h-(--settings-target) items-center gap-2 rounded-lg whitespace-nowrap px-2.5 py-1 text-base/5 text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring aria-[current=page]:bg-zinc-950/5 aria-[current=page]:text-zinc-950 sm:text-sm/5 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:bg-white/8 dark:aria-[current=page]:text-white";
</script>

<nav aria-label="Settings" class="grid grid-cols-1 gap-3">
  <SearchField label="Search settings" name="settings-search" data-autofocus bind:value={query} placeholder="Search" />

  {#each settingsGroups as group (group)}
    {@const items = visible.filter((s) => s.group === group)}
    {#if items.length > 0}
      <div>
        <h2 class="px-2.5 text-sm/6 text-zinc-500 sm:text-xs/6">{group}</h2>
        <ul role="list" class="mt-1 grid gap-0.5">
          {#each items as section (section.href)}
            <li>
              <a
                href={section.href}
                class={itemClass}
                aria-current={sections.isActive(section.href) ? "page" : undefined}
                ><Icon
                  name={section.icon}
                  class="fill-current"
                />{section.label}{#if sections.hinted(section.href)}<StatusDot tone="amber" class="ml-auto" /><span
                    class="sr-only">(updates available)</span
                  >{/if}</a
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/each}
  {#if visible.length === 0}<p class="px-2.5 text-sm/6 text-zinc-500">No setting matches “{query}”.</p>{/if}
  <p class="px-2.5 text-xs/6 text-zinc-500 tabular-nums">Canopy {CANOPY_VERSION}</p>
</nav>
