<script lang="ts">
  import { page } from "$app/state";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import ConnectionStatus from "./ConnectionStatus.svelte";
  import Logo from "./Logo.svelte";

  /** Sidebar content (desktop sidebar and mobile drawer): projects, workers, connection. */
  let { projectId }: { projectId?: string | undefined } = $props();
  const overview = useOverview();

  // Projects with a thread waiting for a person (from live updates seen in this tab).
  const waiting = $derived(
    new Set([...overview.threads.values()].filter((t) => t.status === "waiting_input" || t.pendingInteractions > 0).map((t) => t.projectId)),
  );
  // Empty lists while the gateway is down mean "unknown", not "none".
  const unknown = $derived(overview.connection === "unavailable");
  const itemClass =
    "group flex items-center gap-2 rounded-md px-2 py-2 text-base/6 text-zinc-700 hover:bg-zinc-950/5 hover:text-zinc-950 focus-ring aria-[current=page]:bg-zinc-950/5 aria-[current=page]:text-zinc-950 sm:py-1.5 sm:text-sm/6 dark:text-zinc-300 dark:hover:bg-white/5 dark:hover:text-white dark:aria-[current=page]:bg-white/10 dark:aria-[current=page]:text-white";
</script>

<div class="flex h-full flex-col">
  <div class="flex h-14 shrink-0 items-center px-4">
    <Logo />
  </div>

  <nav class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-2 pb-4" aria-label="Main">
    <div>
      <a href="/" class={itemClass} aria-current={page.url.pathname === "/" ? "page" : undefined}>
        <Icon name="computer-desktop" class="fill-zinc-400 group-aria-[current=page]:fill-zinc-950 dark:fill-zinc-500 dark:group-aria-[current=page]:fill-white" />
        Overview
      </a>
    </div>

    <div>
      <h2 class="px-2 text-sm/6 font-medium text-zinc-500 sm:text-xs/6 dark:text-zinc-400">Projects</h2>
      <ul role="list" class="mt-1 grid gap-0.5">
        {#each overview.projects as project (project.id)}
          <li>
            <a href="/projects/{project.id}" class={itemClass} aria-current={projectId === project.id ? "page" : undefined}>
              <Icon name="folder" class="fill-zinc-400 group-aria-[current=page]:fill-zinc-950 dark:fill-zinc-500 dark:group-aria-[current=page]:fill-white" />
              <span class="min-w-0 flex-1 truncate">{project.name}</span>
              {#if waiting.has(project.id)}
                <StatusDot tone="amber" active />
                <span class="sr-only">(needs input)</span>
              {/if}
            </a>
          </li>
        {:else}
          <li class="px-2 py-1.5 text-sm/6 text-zinc-500 dark:text-zinc-400">{unknown ? "Not loaded yet." : "No projects yet."}</li>
        {/each}
        <li>
          <a href="/#new-project" class={[itemClass, "text-zinc-500 dark:text-zinc-400"]}>
            <Icon name="plus" class="fill-zinc-400 dark:fill-zinc-500" />
            New project
          </a>
        </li>
      </ul>
    </div>

    <div>
      <h2 class="px-2 text-sm/6 font-medium text-zinc-500 sm:text-xs/6 dark:text-zinc-400">Workers</h2>
      <ul role="list" class="mt-1 grid gap-0.5">
        {#each overview.workers as worker (worker.id)}
          <li class="flex items-center gap-2 px-2 py-1.5 text-base/6 sm:py-1 sm:text-sm/6">
            <StatusDot tone={worker.online ? "emerald" : "neutral"} />
            <span class="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300" title={worker.hostname}>{worker.name}</span>
            <span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{worker.online ? osLabel(worker.os) : "Offline"}</span>
          </li>
        {:else}
          <li class="px-2 py-1.5 text-sm/6 text-zinc-500 dark:text-zinc-400">{unknown ? "Not loaded yet." : "No workers registered."}</li>
        {/each}
      </ul>
    </div>
  </nav>

  <div class="shrink-0 border-t border-zinc-950/5 px-4 py-3 dark:border-white/5">
    <ConnectionStatus connection={overview.connection} />
  </div>
</div>
