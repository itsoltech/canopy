<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";

  /** A project's workspaces grouped by the worker (and system) they live on. */
  let { project }: { project: ui.Project } = $props();
  const overview = useOverview();
  const groups = $derived(
    [...new Set(project.workspaces.map((w) => w.workerId))].map((workerId) => ({
      workerId,
      worker: overview.worker(workerId),
      workspaces: project.workspaces.filter((w) => w.workerId === workerId),
    })),
  );
</script>

<ul role="list" class="grid gap-4">
  {#each groups as group (group.workerId)}
    <li>
      <p class="flex items-center gap-2 text-base/6 font-medium sm:text-sm/6">
        <StatusDot tone={group.worker?.online ? "emerald" : "neutral"} />
        {group.worker?.name ?? "Unknown worker"}
        <span class="font-normal text-zinc-500 dark:text-zinc-400">{group.worker ? osLabel(group.worker.os) : ""}{group.worker && !group.worker.online ? " · offline" : ""}</span>
      </p>
      <ul role="list" class="mt-1 grid gap-1 pl-3.5">
        {#each group.workspaces as ws (ws.id)}
          <li class="flex min-w-0 items-center gap-2 text-zinc-600 dark:text-zinc-400">
            <Icon name="folder" class="fill-zinc-400 dark:fill-zinc-500" />
            <code class="truncate font-mono text-sm/6 sm:text-[0.8125rem]/6" title={ws.rootPath}>{ws.rootPath}</code>
          </li>
        {/each}
      </ul>
    </li>
  {/each}
</ul>
