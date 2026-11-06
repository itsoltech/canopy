<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import { basename } from "#lib/shared/format.ts";
  import type { ImportState } from "./import-state.svelte.ts";

  /**
   * Where a source directory goes (docs/import.md, "Projekty"): the suggestion, another project with a workspace on
   * this worker, "No project", or not at all. A directory that no longer exists can only go to "No project".
   */
  let { imports, group }: { imports: ImportState; group: ui.ImportDirectoryGroup } = $props();

  const overview = useOverview();
  const workerId = $derived(imports.scan?.workerId ?? "");

  const suggested = $derived.by(() => {
    const s = group.suggestion;

    if (s?.kind === "workspace") return `Project “${s.projectName}”`;

    return `New project “${basename(group.directory) || group.directory}”`;
  });

  const options = $derived([
    { value: "", label: suggested },
    ...overview.ownProjects
      .filter((p) => p.kind !== "scratch")
      .flatMap((p) =>
        p.workspaces
          .filter((w) => w.workerId === workerId && w.id !== group.suggestion?.workspaceId)
          .map((w) => ({ value: `workspace:${w.id}`, label: `Project “${p.name}”`, description: w.rootPath })),
      ),
    { value: "no_project", label: "No project" },
    { value: "skip", label: "Skip this directory" },
  ]);
</script>

{#if group.exists}
  <div class="w-full sm:w-64">
    <Select
      name="importTarget"
      aria-label={`Target for ${group.directory}`}
      {options}
      value={imports.targets.get(group.directory) ?? ""}
      onchange={(value) => imports.setTarget(group.directory, value)}
    />
  </div>
{:else}
  <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">No project · history only</p>
{/if}
