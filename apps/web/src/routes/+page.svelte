<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerCard from "#lib/features/overview/WorkerCard.svelte";
  import NewProjectForm from "#lib/features/projects/NewProjectForm.svelte";
  import ProjectCard from "#lib/features/projects/ProjectCard.svelte";
  import EmptyState from "#lib/shared/ui/EmptyState.svelte";
  import Page from "#lib/shared/ui/Page.svelte";
  import PageHeader from "#lib/shared/ui/PageHeader.svelte";
  import Section from "#lib/shared/ui/Section.svelte";
  import type { PageProps } from "./$types";

  let { form }: PageProps = $props();
  const overview = useOverview();
  const online = $derived(overview.workers.filter((w) => w.online).length);
</script>

<svelte:head><title>Overview · Open Agents</title></svelte:head>

<Page>
  <PageHeader title="Overview" description="Projects group your agent threads. Workers are the machines that run them." />

  <Section title="Projects" class="mt-10">
    <div class="@container">
      <ul role="list" class="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
        {#each overview.projects as project (project.id)}
          <li><ProjectCard {project} /></li>
        {/each}
      </ul>
    </div>
    {#if overview.projects.length === 0 && overview.connection !== "unavailable"}
      <EmptyState icon="folder" title="No projects yet" description="Create a project, then add a workspace: a directory on one of your workers." />
    {/if}
    <NewProjectForm error={form?.error} class="mt-6 max-w-md" />
  </Section>

  <Section title="Workers" description="{online} of {overview.workers.length} online." class="mt-12">
    {#if overview.workers.length === 0 && overview.connection !== "unavailable"}
      <EmptyState icon="server" title="No workers registered" description="Register a worker on a machine with the gateway CLI (worker add), then start it there." />
    {:else}
      <div class="@container">
        <div class="grid gap-4 @3xl:grid-cols-2">
          {#each overview.workers as worker (worker.id)}
            <WorkerCard {worker} />
          {/each}
        </div>
      </div>
    {/if}
  </Section>
</Page>
