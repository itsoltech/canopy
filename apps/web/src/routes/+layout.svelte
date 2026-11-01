<script lang="ts">
  import "./layout.css";
  import favicon from "#lib/assets/favicon.svg";
  import { ui } from "@open-agents/contracts";
  import { OverviewState, provideOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import { page } from "$app/state";
  import { untrack } from "svelte";
  import type { LayoutProps } from "./$types";

  let { data, children }: LayoutProps = $props();

  // One live overview per tab: seeded once from the server load, then kept current by SSE.
  const overview = new OverviewState(decode(ui.GetOverviewResponseSchema, untrack(() => data.overview)));
  provideOverview(overview);
  $effect(() => overview.connect());
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <title>Open Agents</title>
</svelte:head>

<div class="flex h-dvh bg-slate-50 text-slate-900">
  <nav class="flex w-64 shrink-0 flex-col gap-6 overflow-y-auto border-r border-slate-200 bg-white p-4" aria-label="Main">
    <a href="/" class="text-lg font-semibold">Open Agents</a>
    <section>
      <h2 class="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Projects</h2>
      <ul class="space-y-1">
        {#each overview.projects as project (project.id)}
          <li>
            <a
              href="/projects/{project.id}"
              class="block rounded-md px-2 py-1 text-sm hover:bg-slate-100"
              aria-current={page.url.pathname.startsWith(`/projects/${project.id}`) ? "page" : undefined}>{project.name}</a
            >
          </li>
        {:else}
          <li class="text-sm text-slate-500">No projects yet</li>
        {/each}
      </ul>
    </section>
    <section>
      <h2 class="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Workers</h2>
      <ul class="space-y-1">
        {#each overview.workers as worker (worker.id)}
          <li class="flex items-center justify-between gap-2 text-sm">
            <span class="truncate" title={worker.hostname}>{worker.name}</span>
            <StatusBadge status={worker.online ? "online" : "offline"} />
          </li>
        {/each}
      </ul>
    </section>
  </nav>
  <main class="min-w-0 flex-1 overflow-hidden">
    {@render children()}
  </main>
</div>
