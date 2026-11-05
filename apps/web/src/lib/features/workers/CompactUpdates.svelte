<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import CompactAppUpdate from "#lib/features/desktop/CompactAppUpdate.svelte";
  import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import CompactWorkerUpdate from "./CompactWorkerUpdate.svelte";
  import CompactCliSection from "./CompactCliSection.svelte";
  import CompactComputerUpdate from "./CompactComputerUpdate.svelte";
  import CompactGatewayUpdate from "./CompactGatewayUpdate.svelte";
  import UpdateGroupLabel from "./UpdateGroupLabel.svelte";
  import { homes } from "./computer-updates.ts";
  import UpdateProgress from "./UpdateProgress.svelte";
  import { listedWorkers, updatesAvailable } from "./compact-updates.ts";
  import { cliActions } from "./cli-tools.svelte.ts";
  import type { UpdatesState } from "./updates.svelte.ts";
  import { updateIndicator } from "./update-indicator.ts";

  let {
    updates,
    app,
    class: className,
  }: { updates: UpdatesState; app: DesktopUpdatesState; class?: ClassValue } = $props();

  const cli = cliActions();
  const snapshot = $derived(updates.snapshot);
  const run = $derived(snapshot?.run);
  const busy = $derived(run?.state === "running" || !!updates.pending);

  const checking = $derived(
    snapshot?.checking || updates.pending === "check" || cli.pending["check/"] || app.status?.phase === "checking",
  );

  const summary = $derived(updateIndicator(app.status, snapshot, app.error || updates.error, updates.pending));

  // The bundled gateway and worker ship with this app: "This Canopy app" stands for them; their CLIs stay.
  const bundled = $derived(!!snapshot?.gatewayBundled);
  const groups = $derived(snapshot ? homes(snapshot) : []);

  const workerGroups = $derived(
    groups.map((g) => ({ ...g, workers: listedWorkers(g.home) })).filter((g) => g.workers.length),
  );

  const error = $derived(updates.error || snapshot?.checkError || cli.errors["check/"] || "");
  const completed = $derived(run?.steps.filter((step) => step.state === "succeeded").length ?? 0);

  async function check() {
    await Promise.all([
      snapshot?.admin ? updates.manage({ action: "check" }) : updates.reload(),
      cli.check(),
      app.status ? app.check() : Promise.resolve(),
    ]);
    await updates.reload();
  }
</script>

<section class={["flex max-h-[min(70dvh,32rem)] min-h-0 flex-col", className]} aria-label="Updates center">
  <header class="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2">
    <div class="min-w-0 flex-1">
      <h2 class="text-sm font-semibold">Updates</h2>
      <p class="truncate text-xs/5 text-muted tabular-nums" role="status" title={summary.message}>
        {summary.phase === "error"
          ? "Update failed"
          : summary.phase === "quiet"
            ? "Up to date"
            : summary.phase === "available"
              ? "Updates available"
              : summary.phase === "ready"
                ? "Restart to finish the update"
                : summary.message}
      </p>
    </div>
    <IconButton
      size="sm"
      icon="information-circle"
      label="Update all skips externally managed items. It updates the gateway, binary workers, native agent CLIs, then Canopy apps. Linked computers update last, one at a time."
    />
    <IconButton
      size="sm"
      icon="arrow-path"
      label="Check now"
      disabled={busy || checking}
      loading={checking}
      onclick={() => void check()}
    />
    {#if snapshot && updatesAvailable(snapshot)}<IconButton
        size="sm"
        icon="arrow-up"
        label={run && ["failed", "blocked"].includes(run.state) ? "Retry updates" : "Update all"}
        disabled={busy || !snapshot || (summary.phase === "quiet" && !run)}
        loading={run?.state === "running"}
        onclick={() => void updates.manage({ action: "update_all" })}
      />{/if}
  </header>
  <div class="min-h-0 overflow-y-auto overscroll-contain px-3 py-1">
    {#if error}<p class="break-anywhere py-2 text-xs/5 text-rose-600 dark:text-rose-400" role="status">{error}</p>{/if}
    {#if run && run.state !== "succeeded"}
      <div class="border-b border-divider py-2 text-xs/5">
        <p role="status">
          {run.state === "running" ? `Updating · ${completed}/${run.steps.length}` : "Updates stopped"}
        </p>
        {#if run.state === "running"}<UpdateProgress
            label="Update all progress"
            value={run.steps.length ? (completed / run.steps.length) * 100 : 0}
            class="mt-1"
          />{/if}
        {#if run.reason}<p class="break-anywhere line-clamp-2 text-rose-600 dark:text-rose-400" title={run.reason}>
            {run.reason}
          </p>{/if}
      </div>
    {/if}
    <!-- Computers and workers first; agent CLIs collapse below (docs/updates.md). -->
    {#if snapshot?.computers.length}<UpdateGroupLabel>Computers</UpdateGroupLabel>{/if}
    {#if app.status || app.error}<CompactAppUpdate updates={app} {bundled} />{/if}
    {#if snapshot}
      {#if !bundled}<CompactGatewayUpdate {updates} />{/if}
      {#each snapshot.computers as computer (computer.nodeId)}<CompactComputerUpdate {computer} {updates} />{/each}
      {#if workerGroups.length}<UpdateGroupLabel class="border-t border-divider">Workers</UpdateGroupLabel>{/if}
      {#each workerGroups as group (group.nodeId)}
        {#if workerGroups.length > 1 || group.nodeId}<UpdateGroupLabel class="pt-1 font-normal"
            >{group.name}</UpdateGroupLabel
          >{/if}
        {#each group.workers as worker (worker.workerId)}
          <CompactWorkerUpdate {worker} {updates} home={group.home} />
        {/each}
      {/each}
      <CompactCliSection {groups} disabled={busy} class="border-t" />
    {:else}<p class="py-2 text-xs/5 text-muted" role="status">Loading update status…</p>{/if}
  </div>
  <footer class="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t border-divider px-3 py-2 text-xs/5 text-muted">
    <a href="/settings/workers" class="rounded focus-ring hover:text-ink">Update details</a>
    {#if app.status}<a href="/settings/app-updates" class="rounded focus-ring hover:text-ink">App updates</a>{/if}
  </footer>
</section>
