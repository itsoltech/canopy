<script lang="ts">
  import HabitReviewBadge from "#lib/features/memory/HabitReviewBadge.svelte";
  import { habitsSettingsHref, memorySettingsPath } from "#lib/features/memory/habit-suggestions.svelte.ts";
  import { habitSuggestionCount } from "#lib/features/memory/habits-format.ts";
  import { goto } from "$app/navigation";
  import Combobox from "#lib/shared/ui/Combobox.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { matchesSettingsSection } from "./sections.ts";
  import { useSettingsSections } from "./settings-sections.svelte.ts";

  /**
   * The open settings section as a menu button (narrow screens, where the side nav does not fit): it names
   * where you are and lists every section by group, the open one checked. A dot marks sections that need attention.
   */
  const sections = useSettingsSections();
  let { query = $bindable() }: { query: string } = $props();
  let open = $state(false);
  const current = $derived(sections.current);
  const waiting = $derived(sections.all.some((s) => sections.hinted(s.href)));
  const habitCount = $derived(sections.habitCount);

  const label = $derived(
    [
      `Settings section: ${current?.label ?? "Settings"}`,
      habitCount && habitSuggestionCount(habitCount),
      waiting && "agent CLI updates available",
    ]
      .filter(Boolean)
      .join(", "),
  );
</script>

<Popover
  bind:open
  label="Settings sections"
  sheet
  class="w-[min(22rem,calc(100vw-1rem))]"
  triggerKeydown={(event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open = true;
    }
  }}
>
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
  <Combobox
    inline
    autofocus
    label="Search settings"
    placeholder="Search settings"
    items={sections.all}
    key={(section) => section.href}
    text={(section) => section.label}
    groupOf={(section) => section.group}
    filter={matchesSettingsSection}
    value={current?.href}
    bind:query
    onselect={(section) => {
      open = false;
      void goto(section.href === memorySettingsPath && habitCount && !query.trim() ? habitsSettingsHref : section.href);
    }}
    class="max-h-[min(24rem,var(--float-available-height,24rem))] in-data-sheet:max-h-[70dvh]"
  >
    {#snippet empty(term)}
      <p class="wrap-anywhere">No setting matches “{term}”.</p>
    {/snippet}
    {#snippet option(section, state)}
      <span class="flex min-w-0 items-center gap-2">
        <Icon name={section.icon} tone="inherit" />
        <span class="min-w-0 flex-1 truncate">{section.label}</span>
        {#if section.href === memorySettingsPath && habitCount}<HabitReviewBadge count={habitCount} />{/if}
        {#if sections.hinted(section.href)}
          <StatusDot tone="amber" /><span class="sr-only">Agent CLI updates available</span>
        {/if}
        {#if state.selected}<Icon name="check" class="text-brand-600 dark:text-brand-400" />{/if}
      </span>
    {/snippet}
  </Combobox>
</Popover>
