<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import ThreadDefaultsFields from "#lib/features/settings/ThreadDefaultsFields.svelte";
  import ProjectWorkers from "#lib/features/workspaces/ProjectWorkers.svelte";
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import type { PageProps } from "./$types";

  const route = useSettingsRoute<PageProps["form"]>();
  const overview = useOverview();
  const settings = useSettings();

  const projectId = $derived(route.params.projectId ?? "");
  const project = $derived(overview.project(projectId));
</script>

<svelte:head><title>{project?.name ?? "Project"} · Settings · Canopy</title></svelte:head>

<SettingsHeading title={project?.name ?? "Project"}>
  {#snippet leading()}<ProjectAvatar name={project?.name ?? "?"} class="size-8 rounded-md text-xs/none" />{/snippet}
  {#snippet actions()}
    {#if project && project.workspaces.length > 0}
      <ButtonLink href="/?project={project.id}" variant="primary" icon="pencil-square">New thread</ButtonLink>
    {/if}
  {/snippet}
</SettingsHeading>

{#if project}
  <ConfigNotices
    match={(n) => ["project", "project_settings", "worktree_policy"].includes(n.kind) && n.localId === project.id}
    named={false}
    onchange={() => void settings.reload()}
  />

  <SettingsGroup
    title="Workspaces"
    description="A new thread runs in one of these directories on the project's workers."
  >
    <ProjectWorkers {project} error={route.form?.action === "workspace" ? route.form.error : undefined} />
  </SettingsGroup>

  <SettingsGroup
    title="Thread defaults"
    description="Starting values of new threads in this project, over your own defaults from Settings → Threads."
  >
    <ThreadDefaultsFields
      value={settings.projectDefaults(project.id)}
      workspaces={[{ project, workspaces: project.workspaces }]}
      inherited={settings.threadDefaults}
      onchange={(next) => settings.updateProjectDefaults(project.id, next)}
    />
  </SettingsGroup>
{/if}
