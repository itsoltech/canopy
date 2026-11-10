<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useAddProject } from "#lib/features/projects/add/add-project.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ProjectWorkerRow from "./ProjectWorkerRow.svelte";
  import RemoveWorkspaceDialog from "./RemoveWorkspaceDialog.svelte";
  import WorkspaceDirectoryDialog from "./WorkspaceDirectoryDialog.svelte";

  /**
   * Compact workspace rows and an entry into the worker/source picker.
   * `error`: the page's last workspace action error.
   */
  let { project, error }: { project: ui.Project; error?: string | undefined } = $props();
  const overview = useOverview();
  const add = useAddProject();

  type Editing = { kind: "move" | "remove"; worker: ui.Worker; workspace: ui.Workspace };

  let editing = $state<Editing>();
  let dialogOpen = $state(false);

  const edit = (next: Editing) => {
    editing = next;
    dialogOpen = true;
  };
</script>

{#each project.workspaces as workspace (workspace.id)}
  {@const worker =
    overview.worker(workspace.workerId) ?? create(ui.WorkerSchema, { id: workspace.workerId, name: "Unknown worker" })}
  <ProjectWorkerRow
    {worker}
    {workspace}
    computer={overview.machine(worker.nodeId) ?? "This computer"}
    onmove={() => edit({ kind: "move", worker, workspace })}
    onremove={() => edit({ kind: "remove", worker, workspace })}
  />
{:else}
  <p class="px-4 py-3.5 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    No workspaces yet. Add a directory on a worker to run new threads.
  </p>
{/each}
<div class="px-3 py-2">
  <Button size="sm" icon="plus" onclick={() => add?.show({ project })}>Add workspace</Button>
</div>

{#key editing}
  {#if editing?.kind === "remove"}
    <RemoveWorkspaceDialog
      bind:open={dialogOpen}
      projectName={project.name}
      workerName={editing.worker.name}
      workspace={editing.workspace}
      {error}
    />
  {:else if editing}
    <WorkspaceDirectoryDialog
      bind:open={dialogOpen}
      projectName={project.name}
      worker={editing.worker}
      workspace={editing.workspace}
      {error}
    />
  {/if}
{/key}
