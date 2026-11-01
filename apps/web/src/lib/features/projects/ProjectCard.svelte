<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /** Clickable project summary: workspaces and the workers they live on. */
  let { project }: { project: ui.Project } = $props();
  const overview = useOverview();
  const workers = $derived([...new Set(project.workspaces.map((w) => overview.worker(w.workerId)?.name ?? "Unknown worker"))]);
</script>

<a
  href="/projects/{project.id}"
  class="group flex h-full flex-col rounded-xl bg-white p-4 ring-1 ring-zinc-950/10 hover:ring-zinc-950/20 focus-ring dark:bg-zinc-900 dark:ring-white/10 dark:hover:ring-white/20"
>
  <div class="flex items-center gap-2">
    <Icon name="folder" class="fill-zinc-400 dark:fill-zinc-500" />
    <p class="min-w-0 flex-1 truncate text-base/6 font-medium sm:text-sm/6">{project.name}</p>
    <Icon name="chevron-right" class="fill-zinc-300 group-hover:fill-zinc-500 dark:fill-zinc-600 dark:group-hover:fill-zinc-400" />
  </div>
  <p class="mt-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
    {#if project.workspaces.length === 0}
      No workspaces yet
    {:else}
      {project.workspaces.length} {project.workspaces.length === 1 ? "workspace" : "workspaces"} on {workers.join(", ")}
    {/if}
  </p>
</a>
