<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import ProjectWorkerRow from "./ProjectWorkerRow.svelte";
  import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
  import WorkspaceDirectoryDialog from "./WorkspaceDirectoryDialog.svelte";

  /**
   * Where a project lives: every worker, with the project's directory on it or "Add". A new thread of the
   * project runs on one of these workers. `error`: the page's last workspace action error.
   */
  let { project, error }: { project: ui.Project; error?: string | undefined } = $props();
  const overview = useOverview();

  // Every worker, plus one the overview no longer lists but the project still has a directory on.
  const rows = $derived.by(() => {
    const on = (workerId: string) => project.workspaces.filter((w) => w.workerId === workerId);
    const missing = [...new Set(project.workspaces.map((w) => w.workerId))].filter((id) => !overview.worker(id));
    return [
      ...overview.ownWorkers.map((worker) => ({ worker, workspaces: on(worker.id) })),
      ...missing.map((id) => ({ worker: create(ui.WorkerSchema, { id, name: "Unknown worker" }), workspaces: on(id) })),
    ];
  });

  type Editing = { kind: "add"; worker: ui.Worker } | { kind: "move" | "remove"; worker: ui.Worker; workspace: ui.Workspace };
  let editing = $state<Editing>();
  let dialogOpen = $state(false);
  const edit = (next: Editing) => {
    editing = next;
    dialogOpen = true;
  };
</script>

{#each rows as { worker, workspaces } (worker.id)}
  <ProjectWorkerRow
    {worker}
    {workspaces}
    onadd={() => edit({ kind: "add", worker })}
    onmove={(workspace) => edit({ kind: "move", worker, workspace })}
    onremove={(workspace) => edit({ kind: "remove", worker, workspace })}
  />
{:else}
  <p class="px-4 py-3.5 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    No workers yet. <TextLink href="/settings/workers">Set up a worker</TextLink> to run threads.
  </p>
{/each}

{#key editing}
  {#if editing?.kind === "remove"}
    <RemoveWorkspaceDialog bind:open={dialogOpen} projectName={project.name} workerName={editing.worker.name} workspace={editing.workspace} {error} />
  {:else if editing}
    <WorkspaceDirectoryDialog bind:open={dialogOpen} projectName={project.name} worker={editing.worker} workspace={editing.kind === "move" ? editing.workspace : undefined} {error} />
  {/if}
{/key}
