<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";

  /**
   * The new-thread composer's project pill: a searchable list of your projects, each with the workers it
   * lives on (a project on no worker yet says so; its threads need one first).
   */
  let { projects, value, onselect, class: className }: { projects: readonly ui.Project[]; value: string | undefined; onselect: (project: ui.Project) => void; class?: ClassValue } = $props();
  const overview = useOverview();

  const selected = $derived(projects.find((p) => p.id === value));
  const workersOf = (project: ui.Project) => [...new Set(project.workspaces.map((w) => overview.worker(w.workerId)?.name ?? "Unknown worker"))];
  const detailOf = (project: ui.Project) => {
    const names = workersOf(project);
    return project.kind === "scratch" ? "A private scratch directory on your worker" : names.length === 0 ? "Not on any worker yet" : `On ${names.join(", ")}`;
  };
</script>

<SearchPicker
  label="Choose a project"
  searchLabel="Search projects"
  placeholder="Search projects…"
  items={projects}
  key={(p) => p.id}
  text={(p) => `${p.name} ${workersOf(p).join(" ")}`}
  {value}
  {onselect}
  link={{ href: "/settings/projects", label: "Manage projects" }}
>
  {#snippet trigger(props)}
    <PillButton {...props} class={["pl-1.5", className]} aria-label="Project: {selected?.name ?? 'none'}">
      <ProjectMark name={selected?.name ?? "?"} kind={selected?.kind} />
      <span class="truncate text-zinc-800 dark:text-zinc-200">{selected?.name ?? "Choose a project"}</span>
    </PillButton>
  {/snippet}
  {#snippet option(project, state)}
    <PickerRow title={project.name} detail={detailOf(project)} selected={state.selected}>
      {#snippet leading()}<ProjectMark name={project.name} kind={project.kind} />{/snippet}
    </PickerRow>
  {/snippet}
  {#snippet empty(query)}{query ? `No projects match “${query}”.` : "No projects yet."}{/snippet}
</SearchPicker>
