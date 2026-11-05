<script lang="ts">
  import type { ProjectChoice } from "@canopy/domain/projects";
  import { sharedKey } from "@canopy/domain/computers";
  import ShareScope from "#lib/features/computers/ShareScope.svelte";
  import { useSharedConfig } from "#lib/features/computers/shared-config.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useAddProject } from "#lib/features/projects/add/add-project.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";

  /**
   * Projects of every linked computer, merged by Git origin like the pickers. Each row names where it has
   * workspaces. Settings stay with each computer's own record, so only projects with one here open their page.
   */
  const overview = useOverview();
  const sharing = useSharedConfig();
  const addProject = useAddProject();

  const projects = $derived(overview.projectChoices.filter((p) => p.kind !== "scratch"));

  /** "This computer · Studio", or the workers' names while no computers are linked. */
  const places = (project: ProjectChoice) => {
    if (project.workspaces.length === 0) return "No workspaces yet";
    const workers = project.workspaces.map((w) => overview.worker(w.workerId));

    if (overview.computers.size === 0)
      return [...new Set(workers.map((worker) => worker?.name ?? "Unknown worker"))].join(" · ");

    const nodes = [...new Set(workers.map((worker) => worker?.nodeId ?? ""))].sort(
      (a, b) => Number(Boolean(a)) - Number(Boolean(b)),
    );

    return nodes.map((node) => overview.machine(node) ?? "This computer").join(" · ");
  };

  const localId = (project: ProjectChoice) => project.projectIds.find((id) => !id.includes("~"));
</script>

<svelte:head><title>Projects · Settings · Canopy</title></svelte:head>

<SettingsGroup title="Projects" description="Choose a project to manage its workspaces and threads.">
  {#snippet actions()}
    <Button variant="primary" icon="plus" onclick={() => addProject?.show({ openProject: true })}>Add project</Button>
  {/snippet}
  {#each projects as project (project.id)}
    {@const id = localId(project)}
    {@const key = id && sharedKey.project(id)}
    {#snippet scope()}{#if key}<ShareScope itemKey={key} compact />{/if}{/snippet}
    <SettingsRow
      title={project.name}
      description={places(project)}
      href={id && `/settings/projects/${id}`}
      control={key && (sharing.shared(key) || sharing.conflicts(key).length > 0) ? scope : undefined}
    >
      {#snippet leading()}<ProjectAvatar name={project.name} />{/snippet}
    </SettingsRow>
  {:else}
    <SettingsRow
      title="No projects yet"
      description="A project groups threads. Its workspaces are directories on your workers."
    />
  {/each}
</SettingsGroup>
