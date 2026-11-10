<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ProjectChoice } from "@canopy/domain/projects";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import SidebarProjectChoice from "./SidebarProjectChoice.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const overview = useOverview();
  const settings = useSettings();
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

  const choose = (project: ProjectChoice, checked: boolean) =>
    void settings.updateSidebar({
      projectIds: checked
        ? [...new Set([...selected, ...project.projectIds])]
        : selected.filter((id) => !project.projectIds.includes(id)),
    });
</script>

<!-- The clear button sits left of the trigger, so the trigger's right edge (the popover's anchor) never moves. -->
<div class={["flex shrink-0 items-center gap-1", className]}>
  {#if active}<IconButton
      size="sm"
      icon="x-mark"
      label="Clear filters"
      onclick={() => void settings.updateSidebar({ projectIds: [] })}
    />{/if}
  <Popover label="Filter threads" sheet placement="bottom-end" class="w-72 max-w-[calc(100vw-1rem)] p-1.5">
    {#snippet trigger(props)}
      <button
        type="button"
        {...props}
        aria-label={active ? `Filter projects (${count} selected)` : "Filter projects"}
        class={[
          "relative flex h-9 items-center gap-1 rounded-lg px-2 text-sm/5 focus-ring sm:h-8",
          active
            ? "bg-brand-500/10 text-brand-700 dark:text-brand-300"
            : "text-zinc-500 hover:bg-zinc-950/5 dark:text-zinc-400 dark:hover:bg-white/5",
        ]}
      >
        <Icon name="bars-3" tone={active ? "inherit" : "muted"} />
        {#if selected.length}<span class="min-w-3 tabular-nums">{count}</span>{/if}
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
      <div class="max-h-72 scroll-stable overflow-y-auto" role="group" aria-label="Projects">
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
</div>
