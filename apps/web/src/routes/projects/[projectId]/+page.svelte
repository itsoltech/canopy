<script lang="ts">
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import DirectoryPicker from "#lib/features/workspaces/DirectoryPicker.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  const overview = useOverview();

  const project = $derived(overview.projects.find((p) => p.id === page.params.projectId));
  // Server list, with live status updates from the overview stream laid over it.
  const threads = $derived(
    decode(ui.ListThreadsResponseSchema, data.threads).threads.map((t) => overview.threads.get(t.id) ?? t),
  );
  const onlineWorkers = $derived(overview.workers.filter((w) => w.online));

  let workerId = $state("");
  let rootPath = $state("");
  let workspaceId = $state("");
  const workspace = $derived(project?.workspaces.find((w) => w.id === workspaceId));
  const profiles = $derived(overview.worker(workspace?.workerId ?? "")?.profiles.filter((p) => p.available) ?? []);
  const clientRequestId = crypto.randomUUID();
</script>

<div class="h-full space-y-8 overflow-y-auto p-8">
  <h1 class="text-2xl font-semibold">{project?.name}</h1>

  <section class="card space-y-3">
    <h2 class="font-semibold">Threads</h2>
    <ul class="divide-y divide-slate-100">
      {#each threads as thread (thread.id)}
        <li class="flex items-center justify-between gap-4 py-2">
          <a class="truncate hover:underline" href="/threads/{thread.id}">{thread.title}</a>
          <span class="flex items-center gap-2 text-sm text-slate-500">
            {#if thread.pendingInteractions > 0}<StatusBadge status="pending" />{/if}
            <code class="truncate">{thread.cwd}</code>
            <StatusBadge status={thread.status} />
          </span>
        </li>
      {:else}
        <li class="py-2 text-sm text-slate-500">No threads yet.</li>
      {/each}
    </ul>
  </section>

  <div class="grid gap-8 lg:grid-cols-2">
    <section class="card space-y-3">
      <h2 class="font-semibold">New thread</h2>
      {#if !project?.workspaces.length}
        <p class="text-sm text-slate-500">Add a workspace first.</p>
      {:else}
        <form method="POST" action="?/createThread" use:enhance class="space-y-3">
          <input type="hidden" name="clientRequestId" value={clientRequestId} />
          <div>
            <label class="label" for="workspace">Workspace</label>
            <select id="workspace" name="workspaceId" class="input w-full" bind:value={workspaceId} required>
              <option value="" disabled>Choose…</option>
              {#each project.workspaces as ws (ws.id)}
                <option value={ws.id}>{ws.label || overview.worker(ws.workerId)?.name}: {ws.rootPath}</option>
              {/each}
            </select>
          </div>
          <div>
            <label class="label" for="title">Title</label>
            <input id="title" name="title" class="input w-full" placeholder="What is this thread about?" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label" for="profile">Codex profile</label>
              <select id="profile" name="profileId" class="input w-full">
                {#each profiles as profile (profile.id)}<option value={profile.id === "native" ? "" : profile.id}>{profile.id}</option>{/each}
              </select>
            </div>
            <div>
              <label class="label" for="model">Model</label>
              <input id="model" name="model" class="input w-full" placeholder="default" />
            </div>
          </div>
          <div>
            <label class="label" for="mode">Permissions</label>
            <select id="mode" name="permissionMode" class="input w-full">
              <option value="ASK">Ask before writing or running commands</option>
              <option value="ACCEPT_EDITS">Edit files in the workspace, ask for the rest</option>
              <option value="READ_ONLY">Read only</option>
              <option value="FULL_AUTO">Full auto (sandboxed to the workspace)</option>
            </select>
          </div>
          <div>
            <label class="label" for="message">First message</label>
            <textarea id="message" name="message" class="input w-full" rows="3"></textarea>
          </div>
          <button class="btn-primary">Start thread</button>
          {#if form?.action === "thread" && form.error}<p class="text-sm text-rose-700" role="alert">{form.error}</p>{/if}
        </form>
      {/if}
    </section>

    <section class="card space-y-3">
      <h2 class="font-semibold">Workspaces</h2>
      <ul class="space-y-1 text-sm">
        {#each project?.workspaces ?? [] as ws (ws.id)}
          <li><code>{ws.rootPath}</code> <span class="text-slate-500">on {overview.worker(ws.workerId)?.name ?? ws.workerId}</span></li>
        {/each}
      </ul>
      <form method="POST" action="?/createWorkspace" use:enhance class="space-y-3">
        <div>
          <label class="label" for="worker">Worker</label>
          <select id="worker" name="workerId" class="input w-full" bind:value={workerId} required>
            <option value="" disabled>Choose an online worker…</option>
            {#each onlineWorkers as worker (worker.id)}<option value={worker.id}>{worker.name}</option>{/each}
          </select>
        </div>
        {#if workerId}
          <DirectoryPicker {workerId} bind:value={rootPath} />
          <input type="hidden" name="rootPath" value={rootPath} />
          <input type="hidden" name="label" value={overview.worker(workerId)?.name ?? ""} />
          <button class="btn-primary" disabled={!rootPath}>Add <code class="ml-1">{rootPath || "…"}</code></button>
        {/if}
        {#if form?.action === "workspace" && form.error}<p class="text-sm text-rose-700" role="alert">{form.error}</p>{/if}
      </form>
    </section>
  </div>
</div>
