<script lang="ts">
  import type { ProjectChoice } from "@canopy/domain/projects";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { iconButtonClasses } from "#lib/shared/ui/button.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import SidebarProjectChoice from "./SidebarProjectChoice.svelte";

  const overview = useOverview();
  const settings = useSettings();
  const label = "Filter by project";
  let search = $state("");
  const selected = $derived(settings.sidebar.projectIds);
  const active = $derived(selected.length > 0);

  const projects = $derived(
    overview.projectChoices.filter((p) =>
      [p.name, ...p.aliases].some((name) => name.toLowerCase().includes(search.trim().toLowerCase())),
    ),
  );

  const count = $derived(
    overview.projectChoices.filter((p) => p.projectIds.some((id) => selected.includes(id))).length,
  );

  const selection = $derived(`${count} ${count === 1 ? "project" : "projects"} selected`);
  const triggerLabel = $derived(active ? `${label} (${selection})` : label);

  const choose = (project: ProjectChoice, checked: boolean) =>
    void settings.updateSidebar({
      projectIds: checked
        ? [...new Set([...selected, ...project.projectIds])]
        : selected.filter((id) => !project.projectIds.includes(id)),
    });
</script>

<Popover {label} sheet placement="bottom-end" class="w-72 max-w-[calc(100vw-1rem)] p-1.5">
  {#snippet trigger(props)}
    <button
      type="button"
      {...props}
      aria-label={triggerLabel}
      class={[iconButtonClasses("ghost", "md"), active && "bg-brand-500/10"]}
      {@attach tooltip(triggerLabel)}
    >
      <Icon name="funnel" />
      {#if active}<span
          aria-hidden="true"
          class="pointer-events-none absolute top-0 right-0 grid h-3 min-w-3 place-items-center rounded-full bg-action px-0.5 text-[0.5625rem]/none font-semibold text-on-accent tabular-nums"
          >{count > 99 ? "99+" : count}</span
        >{/if}
      <TouchTarget />
    </button>
  {/snippet}
  <div class="sidebar-scale grid gap-1">
    <SearchField
      name="project-search"
      label="Search projects"
      placeholder="Search projects"
      bind:value={search}
      class="mb-0.5"
      data-autofocus
    />
    <Button
      variant="ghost"
      icon="folder"
      aria-pressed={selected.length === 0}
      onclick={() => void settings.updateSidebar({ projectIds: [] })}
      class="justify-start px-2"
    >
      <span class="min-w-0 flex-1 text-left">All projects</span>{#if !selected.length}<Icon name="check" />{/if}
    </Button>
    <div class="max-h-72 overflow-y-auto" role="group" aria-label="Projects">
      {#each projects as project (project.id)}
        <SidebarProjectChoice
          {project}
          checked={project.projectIds.some((id) => selected.includes(id))}
          onchoose={(checked) => choose(project, checked)}
        />
      {:else}<p class="px-2 py-2 text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400">
          No projects found.
        </p>{/each}
    </div>
  </div>
</Popover>
