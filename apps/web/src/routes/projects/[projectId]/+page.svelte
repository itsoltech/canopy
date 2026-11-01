<script lang="ts">
  import { page } from "$app/state";
  import { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ProjectThreadList from "#lib/features/projects/ProjectThreadList.svelte";
  import NewThreadForm from "#lib/features/threads/components/NewThreadForm.svelte";
  import AddWorkspaceForm from "#lib/features/workspaces/AddWorkspaceForm.svelte";
  import WorkspaceList from "#lib/features/workspaces/WorkspaceList.svelte";
  import Card from "#lib/shared/ui/Card.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import Page from "#lib/shared/ui/Page.svelte";
  import PageHeader from "#lib/shared/ui/PageHeader.svelte";
  import Section from "#lib/shared/ui/Section.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  const overview = useOverview();

  const projectId = $derived(page.params.projectId ?? "");
  const project = $derived(overview.project(projectId));
  // Server list, with live status updates (and new threads, e.g. spawned by agents) laid over it.
  const threads = $derived(overview.liveThreads(projectId, decode(ui.ListThreadsResponseSchema, data.threads).threads));
  const workerCount = $derived(new Set(project?.workspaces.map((w) => w.workerId)).size);
  const waiting = $derived(threads.filter((t) => t.status === "waiting_input" || t.pendingInteractions > 0).length);
  // Open by default while the project has nowhere to run threads yet.
  // svelte-ignore state_referenced_locally
  let addingWorkspace = $state(!project?.workspaces.length);
</script>

<svelte:head><title>{project?.name ?? "Project"} · Open Agents</title></svelte:head>

<Page>
  <PageHeader
    title={project?.name ?? "Project"}
    description="{threads.length} {threads.length === 1 ? 'thread' : 'threads'} · {project?.workspaces.length ?? 0} {project?.workspaces.length === 1 ? 'workspace' : 'workspaces'} on {workerCount} {workerCount === 1 ? 'worker' : 'workers'}{waiting > 0 ? ` · ${waiting} waiting for you` : ''}"
  />

  <div class="mt-10 grid gap-x-12 gap-y-12 lg:grid-cols-[minmax(0,1fr)_24rem]">
    <Section title="Threads">
      <ProjectThreadList {threads} />
    </Section>

    <div class="grid content-start gap-12">
      <Section title="New thread">
        {#if project && project.workspaces.length > 0}
          <Card class="p-4 sm:p-5">
            <NewThreadForm {project} error={form?.action === "thread" ? form.error : undefined} />
          </Card>
        {:else}
          <EmptyState icon="folder-open" title="Add a workspace first" description="A thread runs in a directory on a worker. Add one below." />
        {/if}
      </Section>

      <Section title="Workspaces" description="Directories of this project, on any of your workers.">
        {#if project && project.workspaces.length > 0}
          <WorkspaceList {project} />
        {/if}
        <Disclosure bind:open={addingWorkspace} class="mt-4" summaryClass="py-1 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
          {#snippet summary()}Add a workspace{/snippet}
          <div class="mt-3">
            <AddWorkspaceForm error={form?.action === "workspace" ? form.error : undefined} onadded={() => (addingWorkspace = false)} />
          </div>
        </Disclosure>
      </Section>
    </div>
  </div>
</Page>
