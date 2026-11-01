<script lang="ts">
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { osLabel } from "#lib/features/overview/workers.ts";
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
  // A project spans workers (and systems): its workspaces, grouped by the worker they live on.
  const byWorker = $derived(
    overview.workers
      .map((worker) => ({ worker, workspaces: project?.workspaces.filter((w) => w.workerId === worker.id) ?? [] }))
      .filter((group) => group.workspaces.length > 0),
  );
  const workerName = (id: string) => overview.worker(id)?.name ?? "unknown worker";

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
          <span class="flex min-w-0 items-center gap-2 text-sm text-slate-500">
            {#if thread.pendingInteractions > 0}<StatusBadge status="pending" />{/if}
            <span class="shrink-0">{workerName(thread.workerId)}</span>
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
                <option value={ws.id}>
                  {workerName(ws.workerId)}{overview.worker(ws.workerId)?.online ? "" : " (offline)"}: {ws.rootPath}
                </option>
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
          {#if workspace && !overview.worker(workspace.workerId)?.online}
            <p class="text-sm text-amber-800">The worker is offline. The thread starts when it reconnects.</p>
          {/if}
          <button class="btn-primary">Start thread</button>
          {#if form?.action === "thread" && form.error}<p class="text-sm text-rose-700" role="alert">{form.error}</p>{/if}
        </form>
      {/if}
    </section>

    <section class="card space-y-3">
      <h2 class="font-semibold">Workspaces</h2>
      {#each byWorker as { worker, workspaces } (worker.id)}
        <div class="text-sm">
          <h3 class="flex items-center gap-2 font-medium">
            {worker.name} <span class="font-normal text-slate-500">{osLabel(worker.os)}</span>
            <StatusBadge status={worker.online ? "online" : "offline"} />
          </h3>
          <ul class="mt-1 space-y-1 pl-3">
            {#each workspaces as ws (ws.id)}<li><code>{ws.rootPath}</code></li>{/each}
          </ul>
        </div>
      {:else}
        <p class="text-sm text-slate-500">No workspaces yet. A project can have directories on several workers.</p>
      {/each}
      <form method="POST" action="?/createWorkspace" use:enhance class="space-y-3">
        <div>
          <label class="label" for="worker">Worker</label>
          <select id="worker" name="workerId" class="input w-full" bind:value={workerId} required>
            <option value="" disabled>Choose an online worker…</option>
            {#each onlineWorkers as worker (worker.id)}<option value={worker.id}>{worker.name}</option>{/each}
          </select>
        </div>
        {#if workerId}
          <DirectoryPicker {workerId} os={overview.worker(workerId)?.os ?? ""} bind:value={rootPath} />
          <input type="hidden" name="rootPath" value={rootPath} />
          <input type="hidden" name="label" value={overview.worker(workerId)?.name ?? ""} />
          <button class="btn-primary" disabled={!rootPath}>Add <code class="ml-1">{rootPath || "…"}</code></button>
        {/if}
        {#if form?.action === "workspace" && form.error}<p class="text-sm text-rose-700" role="alert">{form.error}</p>{/if}
      </form>
    </section>
  </div>
</div>
