<script lang="ts">
  import { CANOPY_VERSION } from "@canopy/domain/release/version";
  import HabitReviewBadge from "#lib/features/memory/HabitReviewBadge.svelte";
  import { habitsSettingsHref, memorySettingsPath } from "#lib/features/memory/habit-suggestions.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { matchesSettingsSection, settingsGroups } from "./sections.ts";
  import { useSettingsSections } from "./settings-sections.svelte.ts";

  /** Settings sections by group with a search filter; narrow screens use `SettingsSectionMenu`. */
  const sections = useSettingsSections();
  let { query = $bindable() }: { query: string } = $props();

  const visible = $derived(sections.all.filter((section) => matchesSettingsSection(section, query)));
  const habitCount = $derived(sections.habitCount);

  function revealCurrent(link: HTMLAnchorElement) {
    link.scrollIntoView({ block: "nearest" });
  }

  const itemClass =
    "flex min-h-(--settings-target) items-center gap-2 rounded-lg whitespace-nowrap px-2.5 py-1 text-base/5 text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring aria-[current=page]:bg-zinc-950/5 aria-[current=page]:text-zinc-950 sm:text-sm/5 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:bg-white/8 dark:aria-[current=page]:text-white";
</script>

<nav aria-label="Settings" class="flex h-full min-h-0 flex-col">
  <div class="shrink-0 p-3">
    <SearchField
      label="Search settings"
      name="settings-search"
      data-autofocus
      bind:value={query}
      placeholder="Search"
    />
  </div>

  <div class="grid min-h-0 scroll-stable content-start gap-3 overflow-y-auto px-3 pb-3">
    {#each settingsGroups as group (group)}
      {@const items = visible.filter((s) => s.group === group)}
      {#if items.length > 0}
        <div>
          <h2 class="px-2.5 text-sm/6 text-zinc-500 sm:text-xs/6">{group}</h2>
          <ul role="list" class="mt-1 grid gap-0.5">
            {#each items as section (section.href)}
              {@const reviewHabits = section.href === memorySettingsPath && habitCount}
              <li>
                <a
                  href={reviewHabits && !query.trim() ? habitsSettingsHref : section.href}
                  class={itemClass}
                  aria-current={sections.isActive(section.href) ? "page" : undefined}
                  {@attach sections.isActive(section.href) ? revealCurrent : undefined}
                >
                  <Icon name={section.icon} tone="inherit" />
                  {section.label}
                  {#if reviewHabits}
                    <HabitReviewBadge count={habitCount} class="ml-auto" />
                  {/if}
                  {#if sections.hinted(section.href)}
                    <StatusDot tone="amber" class="ml-auto" />
                    <span class="sr-only">(agent CLI updates available)</span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/each}
    {#if visible.length === 0}<p class="min-w-0 px-2.5 text-sm/6 wrap-anywhere text-zinc-500">
        No setting matches “{query}”.
      </p>{/if}
    <p class="px-2.5 text-xs/6 text-zinc-500 tabular-nums">Canopy {CANOPY_VERSION}</p>
  </div>
</nav>
