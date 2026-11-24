<script lang="ts">
  import HabitReviewBadge from "#lib/features/memory/HabitReviewBadge.svelte";
  import { habitsSettingsHref, memorySettingsPath } from "#lib/features/memory/habit-suggestions.svelte.ts";
  import { habitSuggestionCount } from "#lib/features/memory/habits-format.ts";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuGroup from "#lib/shared/ui/MenuGroup.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { settingsGroups } from "./sections.ts";
  import { useSettingsSections } from "./settings-sections.svelte.ts";

  /**
   * The open settings section as a menu button (narrow screens, where the side nav does not fit): it names
   * where you are and lists every section by group, the open one checked. A dot marks sections that need attention.
   */
  const sections = useSettingsSections();
  const current = $derived(sections.current);
  const waiting = $derived(sections.all.some((s) => sections.hinted(s.href)));
  const habitCount = $derived(sections.habitCount);

  const label = $derived(
    [
      `Settings section: ${current?.label ?? "Settings"}`,
      habitCount && habitSuggestionCount(habitCount),
      waiting && "updates available",
    ]
      .filter(Boolean)
      .join(", "),
  );
</script>

<DropdownMenu label="Settings sections" sheet>
  {#snippet trigger(props)}
    <button
      type="button"
      aria-label={label}
      class="relative flex min-h-(--settings-target) items-center gap-2 rounded-lg px-2 whitespace-nowrap text-zinc-950 focus-ring hover:bg-zinc-950/5 aria-expanded:bg-zinc-950/5 dark:text-white dark:hover:bg-white/5 dark:aria-expanded:bg-white/8"
      {...props}
    >
      {current?.label ?? "Settings"}
      <span class="relative inline-flex">
        <Icon name="chevron-up-down" class="fill-zinc-500 dark:fill-zinc-400" />
        {#if waiting || habitCount}<span class="absolute -top-0.5 -right-1 flex"><StatusDot tone="amber" /></span>{/if}
      </span>
      <TouchTarget />
    </button>
  {/snippet}
  {#each settingsGroups as group (group)}
    {@const items = sections.all.filter((s) => s.group === group)}
    {#if items.length > 0}
      <MenuGroup label={group}>
        {#each items as section (section.href)}
          {@const reviewHabits = section.href === memorySettingsPath && habitCount}
          <MenuItem
            href={reviewHabits ? habitsSettingsHref : section.href}
            current={sections.isActive(section.href)}
            description={sections.hinted(section.href) ? "Updates available" : undefined}
          >
            {section.label}
            {#if reviewHabits}
              <HabitReviewBadge count={habitCount} class="ml-1.5 align-middle" />
            {/if}
          </MenuItem>
        {/each}
      </MenuGroup>
    {/if}
  {/each}
</DropdownMenu>
