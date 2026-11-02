<script lang="ts">
  import { page } from "$app/state";
  import { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ProjectThreadList from "#lib/features/projects/ProjectThreadList.svelte";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import ThreadDefaultsFields from "#lib/features/settings/ThreadDefaultsFields.svelte";
  import ProjectWorkers from "#lib/features/workspaces/ProjectWorkers.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  const overview = useOverview();
  const settings = useSettings();

  const projectId = $derived(page.params.projectId ?? "");
  const project = $derived(overview.project(projectId));
  // Server list, with live status updates (and new threads, e.g. spawned by agents) laid over it.
  const threads = $derived(overview.liveThreads(projectId, decode(ui.ListThreadsResponseSchema, data.threads).threads));
</script>

<svelte:head><title>{project?.name ?? "Project"} · Settings · Open Agents</title></svelte:head>

<SettingsHeading title={project?.name ?? "Project"}>
  {#snippet leading()}<ProjectAvatar name={project?.name ?? "?"} class="size-8 rounded-md text-xs/none" />{/snippet}
  {#snippet actions()}
    {#if project && project.workspaces.length > 0}
      <ButtonLink href="/?project={project.id}" variant="primary" icon="pencil-square">New thread</ButtonLink>
    {/if}
  {/snippet}
</SettingsHeading>

{#if project}
  <SettingsGroup title="Workers" description="Where this project lives: a directory on each worker you add it to. A new thread runs on one of them.">
    <ProjectWorkers {project} error={form?.action === "workspace" ? form.error : undefined} />
  </SettingsGroup>

  <SettingsGroup title="Thread defaults" description="Starting values of new threads in this project, over your own defaults from Settings → Threads.">
    <ThreadDefaultsFields
      value={settings.projectDefaults(project.id)}
      workspaces={[{ project, workspaces: project.workspaces }]}
      inherited={settings.threadDefaults}
      onchange={(next) => settings.updateProjectDefaults(project.id, next)}
    />
  </SettingsGroup>
{/if}

<SettingsGroup title="Threads" description="Main threads with their side threads.">
  <div class="p-2"><ProjectThreadList {threads} /></div>
</SettingsGroup>
