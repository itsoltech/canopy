<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";
  import MachineBadge from "#lib/features/computers/MachineBadge.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  /**
   * The new-thread composer's project pill: a searchable list of your projects, each with the workers it
   * lives on (a project on no worker yet says so; its threads need one first).
   */
  let {
    projects,
    value,
    onselect,
    class: className,
  }: {
    projects: readonly ui.Project[];
    value: string | undefined;
    onselect: (project: ui.Project) => void;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const available = $derived(projects.filter((project) => !project.nodeId || capabilities?.linkedComputers));

  const selected = $derived(available.find((p) => p.id === value));

  const workersOf = (project: ui.Project) => [
    ...new Set(project.workspaces.map((w) => overview.worker(w.workerId)?.name ?? "Unknown worker")),
  ];

  const detailOf = (project: ui.Project) => {
    const names = workersOf(project);

    return project.kind === "scratch"
      ? `A private scratch directory on ${project.nodeId ? "its" : "your"} worker`
      : names.length === 0
        ? "Not on any worker yet"
        : `On ${names.join(", ")}`;
  };
</script>

<div class={["flex min-w-0 items-center", className]}>
  <SearchPicker
    label="Choose a project"
    searchLabel="Search projects"
    placeholder="Search projects…"
    items={available}
    key={(p) => p.id}
    text={(p) => `${p.name} ${workersOf(p).join(" ")} ${overview.machine(p.nodeId) ?? ""}`}
    {value}
    {onselect}
    link={{ href: "/settings/projects", label: "Manage projects" }}
  >
    {#snippet trigger(props)}
      <PillButton {...props} class="min-w-0 flex-1 pl-1.5" aria-label="Project: {selected?.name ?? 'none'}">
        <ProjectMark name={selected?.name ?? "?"} kind={selected?.kind} />
        <span class="truncate text-zinc-800 dark:text-zinc-200">{selected?.name ?? "Choose a project"}</span>
        {#if selected?.nodeId}<MachineBadge nodeId={selected.nodeId} compact />{/if}
      </PillButton>
    {/snippet}
    {#snippet option(project, state)}
      <PickerRow
        title={project.name}
        detail={detailOf(project)}
        status={overview.machine(project.nodeId)}
        selected={state.selected}
      >
        {#snippet leading()}<ProjectMark name={project.name} kind={project.kind} />{/snippet}
      </PickerRow>
    {/snippet}
    {#snippet empty(query)}{query ? `No projects match “${query}”.` : "No projects yet."}{/snippet}
  </SearchPicker>
  {#if selected?.kind === "scratch"}
    <HintIcon
      label="About the scratch directory"
      text="A dedicated scratch directory is created when you send. Files are kept until you remove them manually."
    />
  {/if}
</div>
