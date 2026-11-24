<script lang="ts">
  import type { SidebarRow } from "@canopy/domain/sidebar-rows";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { formatCount } from "#lib/shared/format.ts";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let { entry, searching }: { entry: SidebarRow; searching: boolean } = $props();
  const collapsed = $derived(!searching && devicePreferences.view.collapsedSidebarGroups.includes(entry.key));
  const isProject = $derived(entry.groupKind === "project");

  const newThread = $derived.by(() => {
    if (!entry.project || (!isProject && !entry.groupWorkspaceId)) return undefined;
    const query = new URLSearchParams({ project: entry.project.id });

    if (entry.groupWorkspaceId) {
      query.set("workspace", entry.groupWorkspaceId);
      query.set("worktree", entry.groupWorktreeId ?? "");
    }

    return {
      href: `/threads/new?${query}`,
      label: isProject ? `New thread in ${entry.heading}` : `New thread in ${entry.project.name} on ${entry.heading}`,
    };
  });

  function toggle() {
    const groups = devicePreferences.view.collapsedSidebarGroups;

    devicePreferences.setView({
      collapsedSidebarGroups: collapsed ? groups.filter((key) => key !== entry.key) : [...groups, entry.key],
    });
  }
</script>

<div class={["relative min-w-0", isProject && "pt-2", newThread && "sidebar-group-row"]}>
  <h2 class="min-w-0">
    <button
      type="button"
      class={[
        "sidebar-row-padding sidebar-group-heading flex h-9 w-full min-w-0 items-center rounded-lg text-left text-sm font-medium text-zinc-500 focus-ring hover:bg-zinc-950/4 sm:h-8 sm:text-xs dark:text-zinc-400 dark:hover:bg-white/4",
        isProject ? "gap-1" : "gap-1.5",
      ]}
      aria-expanded={!collapsed}
      aria-label={`${entry.heading}, ${formatCount(entry.count ?? 0)} ${(entry.count ?? 0) === 1 ? "thread" : "threads"}`}
      title={entry.groupTitle || entry.heading}
      disabled={searching}
      onclick={toggle}
    >
      {#if isProject}
        <ProjectMark
          name={entry.heading ?? "?"}
          kind={entry.project?.kind}
          color={entry.project?.color}
          imageBase64={entry.project?.imageBase64}
        />
      {:else}<Icon name="git-branch" size="xs" />{/if}
      <span class="min-w-0 flex-1 truncate">{entry.heading}</span>
      <span class="sidebar-group-meta flex shrink-0 items-center gap-1.5">
        <span class="text-xs font-normal text-zinc-400 tabular-nums dark:text-zinc-500"
          >{formatCount(entry.count ?? 0)}</span
        >
        <Icon name="chevron-right" size="sm" class={["t-acc-chevron", !collapsed && "rotate-90"]} />
      </span>
      {#if newThread && !searching}<span class="sidebar-group-chevron-hit-area" aria-hidden="true"></span>{/if}
    </button>
  </h2>
  {#if newThread}
    <a
      href={newThread.href}
      class="sidebar-group-new-thread grid items-center justify-items-end rounded-lg text-icon-muted focus-ring hover:bg-zinc-950/5 hover:text-icon-emphasis dark:hover:bg-white/10"
      aria-label={newThread.label}
      {@attach tooltip(newThread.label)}
    >
      <Icon name="pencil-square" size="sm" />
    </a>
  {/if}
</div>
