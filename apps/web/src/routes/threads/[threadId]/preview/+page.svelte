<script lang="ts">
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { onMount, untrack } from "svelte";
  import type { AgentPreviewTarget } from "@canopy/contracts";
  import { applicationName } from "#lib/application-name.ts";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
  import AgentPreviewPanel from "#lib/features/preview/AgentPreviewPanel.svelte";
  import { initialPreviewChoice } from "#lib/features/preview/preview-window.ts";
  import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
  import { applyDeviceAppearance } from "#lib/features/settings/device-appearance.ts";

  const overview = new OverviewState(undefined);
  const threadId = $derived(page.params.threadId ?? "");
  const thread = $derived(overview.threads.get(threadId));
  const worker = $derived(overview.worker(thread?.workerId ?? ""));
  const threadTitle = $derived(thread?.title || "Preview");
  const away = $derived(thread?.nodeId ? awayReason(overview.computer(thread.nodeId)) : undefined);
  const initial = untrack(() => initialPreviewChoice(page.url.hash));
  let tool = $state(initial.tool);
  let fit = $state(initial.fit);
  let target = $state<AgentPreviewTarget | undefined>(initial.target);
  let workerId = initial.workerId;

  $effect(() => overview.connect());

  onMount(() => devicePreferences.connect());

  $effect(() => applyDeviceAppearance(devicePreferences));

  // The initial target was selected on a specific worker. Discard it if the thread changes workers.
  $effect.pre(() => {
    if (!worker) return;

    if (workerId && workerId !== worker.id) target = undefined;
    workerId = worker.id;
  });

  onMount(() => {
    if (page.url.hash) replaceState(page.url.pathname + page.url.search, page.state);
  });
</script>

<svelte:head>
  <title>{thread?.title ? `${threadTitle} · Preview · ${applicationName}` : `Preview · ${applicationName}`}</title>
</svelte:head>

<main class="density-chrome flex h-dvh min-w-0 flex-col bg-surface text-ink">
  <h1 class="min-w-0 shrink-0 truncate border-b border-divider px-3 py-2 text-sm font-medium" title={threadTitle}>
    {threadTitle}
  </h1>
  {#if overview.connection !== "live"}
    <p class="m-auto px-4 text-center text-sm text-muted" role="status">
      {overview.connection === "unavailable" ? "Reconnect to Canopy to open this preview." : "Connecting to Canopy…"}
    </p>
  {:else if !thread || thread.archivedAt || thread.status === "archived"}
    <p class="m-auto px-4 text-center text-sm text-muted" role="status">
      This thread is unavailable. Open Preview from an active thread.
    </p>
  {:else}
    <div class="min-h-0 min-w-0 flex-1">
      {#key `${threadId}:${worker?.id ?? ""}`}
        <AgentPreviewPanel
          {threadId}
          {worker}
          offline={away ?? ""}
          active
          location="window"
          bind:tool
          bind:target
          bind:fit
        />
      {/key}
    </div>
  {/if}
</main>
