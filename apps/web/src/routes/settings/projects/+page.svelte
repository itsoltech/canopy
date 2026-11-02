<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import NewProjectForm from "#lib/features/projects/NewProjectForm.svelte";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import type { PageProps } from "./$types";

  const route = useSettingsRoute<PageProps["form"]>();
  const overview = useOverview();
  const summary = (workspaces: { workerId: string; rootPath: string }[]) => {
    if (workspaces.length === 0) return "No workspaces yet";
    const workers = [...new Set(workspaces.map((w) => overview.worker(w.workerId)?.name ?? "unknown worker"))];
    return workspaces.length === 1 ? `${workers[0]} · ${workspaces[0]?.rootPath}` : `${workspaces.length} workspaces on ${workers.join(", ")}`;
  };
</script>

<svelte:head><title>Projects · Settings · Open Agents</title></svelte:head>

<SettingsGroup title="Projects" description="Choose a project to manage its workspaces and threads.">
  {#each overview.projects as project (project.id)}
    <SettingsRow title={project.name} description={summary(project.workspaces)} href="/settings/projects/{project.id}">
      {#snippet leading()}<ProjectAvatar name={project.name} />{/snippet}
    </SettingsRow>
  {:else}
    <SettingsRow title="No projects yet" description="A project groups threads; its workspaces are directories on your workers." />
  {/each}
</SettingsGroup>

<SettingsGroup title="New project">
  <div class="p-4"><NewProjectForm error={route.form?.error} /></div>
</SettingsGroup>
