<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useAddProject } from "#lib/features/projects/add/add-project.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";

  let { worker, workspaceId = $bindable("") }: { worker: ui.Worker; workspaceId?: string } = $props();

  const overview = useOverview();
  const addProject = useAddProject();

  const options = $derived(
    overview.ownProjects
      .filter((project) => project.kind !== "scratch")
      .flatMap((project) =>
        project.workspaces
          .filter((workspace) => workspace.workerId === worker.id)
          .map((workspace) => ({ value: workspace.id, label: project.name, description: workspace.rootPath })),
      ),
  );
</script>

<div class="grid gap-3 sm:justify-items-start">
  {#if options.length}
    <div class="w-full min-w-0 sm:max-w-80">
      <Select
        aria-label="Project for your first thread"
        options={[{ value: "", label: "No project" }, ...options]}
        value={workspaceId}
        onchange={(value) => (workspaceId = value)}
      />
    </div>
  {/if}
  <div class="flex flex-wrap gap-2">
    <Button variant="secondary" onclick={() => addProject?.show({ workerId: worker.id })}>Add project</Button>
    <Button variant="secondary" onclick={() => addProject?.show({ workerId: worker.id, findGit: true })}
      >Find Git repositories</Button
    >
  </div>
</div>
