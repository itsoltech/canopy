<script lang="ts">
  import type { SidebarRow } from "@canopy/domain/sidebar-rows";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { formatCount } from "#lib/shared/format.ts";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let { entry, searching }: { entry: SidebarRow; searching: boolean } = $props();
  const collapsed = $derived(!searching && devicePreferences.view.collapsedSidebarGroups.includes(entry.key));

  function toggle() {
    const groups = devicePreferences.view.collapsedSidebarGroups;

    devicePreferences.setView({
      collapsedSidebarGroups: collapsed ? groups.filter((key) => key !== entry.key) : [...groups, entry.key],
    });
  }
</script>

<h2 class={["min-w-0", entry.groupKind === "project" && "pt-2"]}>
  <button
    type="button"
    class="sidebar-row-padding sidebar-group-heading flex h-9 w-full min-w-0 items-center gap-1.5 rounded-lg text-left text-sm font-medium text-zinc-500 focus-ring hover:bg-zinc-950/4 sm:h-8 sm:text-xs dark:text-zinc-400 dark:hover:bg-white/4"
    aria-expanded={!collapsed}
    aria-label={`${entry.heading}, ${formatCount(entry.count ?? 0)} ${(entry.count ?? 0) === 1 ? "thread" : "threads"}`}
    title={entry.groupTitle || entry.heading}
    disabled={searching}
    onclick={toggle}
  >
    {#if entry.groupKind === "project"}
      <ProjectMark name={entry.heading ?? "?"} kind={entry.project?.kind} class="size-5" />
    {:else}<Icon name="git-branch" size="xs" />{/if}
    <span class="min-w-0 flex-1 truncate">{entry.heading}</span>
    <span class="shrink-0 text-xs font-normal text-zinc-400 tabular-nums dark:text-zinc-500"
      >{formatCount(entry.count ?? 0)}</span
    >
    <Icon name="chevron-right" class={["t-acc-chevron size-3 shrink-0", !collapsed && "rotate-90"]} />
  </button>
</h2>
