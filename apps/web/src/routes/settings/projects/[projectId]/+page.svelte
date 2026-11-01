<script lang="ts">
  import { page } from "$app/state";
  import { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import ProjectThreadList from "#lib/features/projects/ProjectThreadList.svelte";
  import AddWorkspaceForm from "#lib/features/workspaces/AddWorkspaceForm.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  const overview = useOverview();

  const projectId = $derived(page.params.projectId ?? "");
  const project = $derived(overview.project(projectId));
  // Server list, with live status updates (and new threads, e.g. spawned by agents) laid over it.
  const threads = $derived(overview.liveThreads(projectId, decode(ui.ListThreadsResponseSchema, data.threads).threads));
  // Open by default while the project has nowhere to run threads yet.
  // svelte-ignore state_referenced_locally
  let addingWorkspace = $state(!project?.workspaces.length);
</script>

<svelte:head><title>{project?.name ?? "Project"} · Settings · Open Agents</title></svelte:head>

<div class="flex flex-wrap items-center justify-between gap-4">
  <div class="flex min-w-0 items-center gap-3">
    <ProjectAvatar name={project?.name ?? "?"} class="size-8 rounded-md text-xs/none" />
    <h1 class="truncate text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white">{project?.name ?? "Project"}</h1>
  </div>
  {#if project && project.workspaces.length > 0}
    <ButtonLink href="/?project={project.id}" variant="primary" icon="pencil-square">New thread</ButtonLink>
  {/if}
</div>

<SettingsGroup title="Workspaces" description="Directories of this project, on any of your workers. A thread runs in one of them.">
  {#each project?.workspaces ?? [] as ws (ws.id)}
    {@const worker = overview.worker(ws.workerId)}
    <SettingsRow title={ws.rootPath} description="{worker?.name ?? 'Unknown worker'} · {worker ? osLabel(worker.os) : ''}">
      {#snippet leading()}<Icon name="folder" class="fill-zinc-400 dark:fill-zinc-500" />{/snippet}
      {#snippet control()}
        <span class="flex items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5"><StatusDot tone={worker?.online ? "emerald" : "neutral"} />{worker?.online ? "Online" : "Offline"}</span>
      {/snippet}
    </SettingsRow>
  {/each}
  <div class="px-4 py-3">
    <Disclosure bind:open={addingWorkspace} summaryClass="py-1 text-base/6 font-medium text-zinc-700 sm:text-sm/6 dark:text-zinc-300">
      {#snippet summary()}Add a workspace{/snippet}
      <div class="mt-3 pb-1">
        <AddWorkspaceForm error={form?.action === "workspace" ? form.error : undefined} onadded={() => (addingWorkspace = false)} />
      </div>
    </Disclosure>
  </div>
</SettingsGroup>

<SettingsGroup title="Threads" description="Main threads with their side threads.">
  <div class="p-2"><ProjectThreadList {threads} /></div>
</SettingsGroup>
