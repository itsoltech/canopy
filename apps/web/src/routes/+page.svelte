<script lang="ts">
  import { enhance } from "$app/forms";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import type { PageProps } from "./$types";

  let { form }: PageProps = $props();
  const overview = useOverview();
</script>

<div class="h-full space-y-8 overflow-y-auto p-8">
  <section class="card max-w-xl">
    <h1 class="text-lg font-semibold">New project</h1>
    <form method="POST" action="?/createProject" use:enhance class="mt-3 flex gap-2">
      <label class="sr-only" for="project-name">Project name</label>
      <input id="project-name" name="name" class="input flex-1" placeholder="e.g. open-agents" required />
      <button class="btn-primary">Create</button>
    </form>
    {#if form?.error}<p class="mt-2 text-sm text-rose-700" role="alert">{form.error}</p>{/if}
  </section>

  <section>
    <h2 class="mb-3 text-lg font-semibold">Workers</h2>
    <div class="grid gap-4 md:grid-cols-2">
      {#each overview.workers as worker (worker.id)}
        <article class="card space-y-2">
          <header class="flex items-center justify-between">
            <h3 class="font-medium">{worker.name}</h3>
            <StatusBadge status={worker.online ? "online" : "offline"} />
          </header>
          <p class="text-sm text-slate-600">{worker.hostname} · {worker.os} · config v{worker.appliedVersion}/{worker.configVersion}</p>
          <p class="text-sm"><span class="text-slate-500">Roots:</span> {worker.allowedRoots.join(", ") || "none"}</p>
          <p class="text-sm">
            <span class="text-slate-500">Providers:</span>
            {#each worker.providers as provider (provider.provider)}
              <span class="mr-2">{provider.provider === 1 ? "Claude" : "Codex"} {provider.available ? provider.version : `(${provider.detail})`}</span>
            {/each}
          </p>
          <p class="text-sm"><span class="text-slate-500">Profiles:</span> {worker.profiles.map((p) => `${p.id}${p.available ? "" : " (unavailable)"}`).join(", ")}</p>
          {#if worker.configIssues.length > 0}
            <ul class="list-inside list-disc text-sm text-amber-800">
              {#each worker.configIssues as issue (issue.path)}<li>{issue.path}: {issue.message}</li>{/each}
            </ul>
          {/if}
        </article>
      {:else}
        <p class="text-sm text-slate-500">No workers. Register one with <code>bun apps/gateway/src/cli.ts worker add</code>.</p>
      {/each}
    </div>
  </section>
</div>
