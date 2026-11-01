<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ui } from "@open-agents/contracts";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MetaList from "#lib/shared/ui/MetaList.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { permissionLabel, providerLabel } from "../labels.ts";
  import { isSide } from "../thread-tree.ts";
  import AgentBadge from "./AgentBadge.svelte";

  /** Breadcrumbs, title, status and placement (worker, directory, agent settings) of a thread. */
  let {
    thread,
    project,
    main,
    worker,
    actions,
  }: { thread: ui.Thread; project: ui.Project | undefined; main: ui.Thread | undefined; worker: ui.Worker | undefined; actions?: Snippet } = $props();
  const side = $derived(isSide(thread));
</script>

<header class="px-4 pt-3 pb-3 sm:px-6 sm:pt-4">
  <nav aria-label="Breadcrumb">
    <ol role="list" class="flex min-w-0 items-center gap-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
      <li class="min-w-0"><a href={project ? `/projects/${project.id}` : "/"} class="block truncate rounded-sm hover:text-zinc-950 focus-ring dark:hover:text-white">{project?.name ?? "Project"}</a></li>
      {#if side && main && main.id !== thread.id}
        <li class="flex min-w-0 items-center gap-1">
          <Icon name="chevron-right" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
          <a href="/threads/{main.id}" class="block truncate rounded-sm hover:text-zinc-950 focus-ring dark:hover:text-white">{main.title}</a>
        </li>
      {/if}
    </ol>
  </nav>

  <div class="mt-1 flex items-start justify-between gap-x-4">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <h1 class="min-w-0 truncate text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">{thread.title}</h1>
      <StatusBadge status={thread.status} />
      {#if side}<Badge icon="arrows-right-left">Side thread</Badge>{/if}
      {#if thread.spawnedByAgent}<AgentBadge />{/if}
    </div>
    {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
  </div>

  <MetaList class="mt-2">
    <span class="flex items-center gap-1.5">
      <StatusDot tone={worker?.online ? "emerald" : "neutral"} />
      {worker?.name ?? "Unknown worker"}{worker && !worker.online ? " (offline)" : ""}
    </span>
    {#if worker}<span class="max-sm:hidden">{osLabel(worker.os)}</span>{/if}
    <code class="max-w-full truncate font-mono text-[0.8125rem]" title={thread.cwd}>{thread.cwd}</code>
    <span class="max-sm:hidden">{providerLabel(thread.provider)}{thread.providerProfileId ? ` via ${thread.providerProfileId}` : ""}{thread.model ? ` · ${thread.model}` : ""}</span>
    <span class="max-sm:hidden">{permissionLabel(thread.permissionMode)}</span>
  </MetaList>
</header>
