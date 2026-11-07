<script lang="ts">
  import type { ProjectChoice } from "@canopy/domain/projects";
  import type { ClassValue } from "svelte/elements";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import ProjectMark from "#lib/shared/ui/ProjectMark.svelte";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";

  /**
   * One choice per linked project identity, with alternate names kept searchable and visible.
   */
  let {
    projects,
    value,
    onselect,
    class: className,
  }: {
    projects: readonly ProjectChoice[];
    value: string | undefined;
    onselect: (project: ProjectChoice) => void;
    class?: ClassValue;
  } = $props();

  const capabilities = useGatewayCapabilities();
  const overview = useOverview();

  const available = $derived(
    projects.filter((project) => !project.nodeId || !capabilities?.methods || capabilities.linkedComputers),
  );

  const selected = $derived(available.find((p) => p.id === value));

  const detailOf = (project: ProjectChoice) => {
    return project.kind === "scratch"
      ? "A private scratch directory on the worker you choose."
      : project.aliases.length
        ? `Also named ${project.aliases.map((name) => `“${name}”`).join(", ")}`
        : undefined;
  };
</script>

<div class={["flex min-w-0 items-center", className]}>
  <SearchPicker
    label="Choose a project"
    searchLabel="Search projects"
    placeholder="Search projects…"
    items={available}
    key={(p) => p.id}
    text={(p) => `${p.name} ${p.aliases.join(" ")}`}
    {value}
    {onselect}
    disabled={(project) => Boolean(overview.projectAway(project))}
    link={{ href: "/settings/projects", label: "Manage projects" }}
  >
    {#snippet trigger(props)}
      <PillButton {...props} class="min-w-0 flex-1 pl-1.5" aria-label="Project: {selected?.name ?? 'none'}">
        <ProjectMark name={selected?.name ?? "?"} kind={selected?.kind} />
        <span class="truncate text-zinc-800 dark:text-zinc-200">{selected?.name ?? "Choose a project"}</span>
      </PillButton>
    {/snippet}
    {#snippet option(project, state)}
      <PickerRow
        title={project.name}
        detail={overview.projectAway(project) ?? detailOf(project)}
        status={overview.projectAway(project) ? "Offline" : undefined}
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
      text="Canopy creates a scratch directory when you send. Its files stay until you remove them."
    />
  {/if}
</div>
