<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import type { WorktreeScope } from "./worktree-settings.svelte.ts";

  /** "Applying settings for [project] across [computer]": the scope the worktree settings below change. */
  let {
    scope,
    onchange,
    disabled = false,
    class: className,
  }: {
    scope: WorktreeScope;
    onchange: (scope: WorktreeScope) => void;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();

  const projects = $derived([
    { value: "", label: "All projects" },
    ...overview.ownProjects.filter((p) => p.kind !== "scratch").map((p) => ({ value: p.id, label: p.name })),
  ]);

  const workers = $derived([
    { value: "", label: "All computers" },
    ...overview.ownWorkers.map((w) => ({ value: w.id, label: w.name })),
  ]);
</script>

<p
  class={[
    "flex flex-wrap items-center gap-x-2 gap-y-2 text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400",
    className,
  ]}
>
  <span>Applying settings for</span>
  <Select
    name="worktreeProject"
    {disabled}
    aria-label="Project"
    value={scope.projectId}
    options={projects}
    onchange={(projectId) => onchange({ ...scope, projectId })}
    class="w-44"
  />
  <span>across</span>
  <Select
    name="worktreeWorker"
    {disabled}
    aria-label="Computer"
    value={scope.workerId}
    options={workers}
    onchange={(workerId) => onchange({ ...scope, workerId })}
    class="w-44"
  />
</p>
