<script lang="ts">
  import type { Snippet } from "svelte";
  import { homeAppComputer } from "@canopy/domain/release/update-actions";
  import CompactAppUpdate from "#lib/features/desktop/CompactAppUpdate.svelte";
  import type { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import CompactWorkerUpdate from "./CompactWorkerUpdate.svelte";
  import CompactCliSection from "./CompactCliSection.svelte";
  import CompactComputerUpdate from "./CompactComputerUpdate.svelte";
  import CompactGatewayUpdate from "./CompactGatewayUpdate.svelte";
  import UpdateGroupLabel from "./UpdateGroupLabel.svelte";
  import { homes } from "@canopy/domain/release/computer-update";
  import { listedWorkers } from "./compact-updates.ts";
  import type { UpdatesState } from "./updates.svelte.ts";

  /**
   * The updates center's rows, in the popover and in Settings → Workers → Updates (docs/updates.md): this computer,
   * linked computers, workers grouped by computer, then agent CLIs collapsed. `gateway` follows a server's gateway row.
   */
  let {
    updates,
    app,
    allowForce = false,
    gateway,
  }: { updates: UpdatesState; app: DesktopUpdatesState; allowForce?: boolean; gateway?: Snippet } = $props();

  const snapshot = $derived(updates.snapshot);

  // The bundled gateway and worker ship with this app: "This Canopy app" stands for them; their CLIs stay.
  const bundled = $derived(!!snapshot?.gatewayBundled);

  const local = $derived(snapshot && (!app.status || app.remote) ? homeAppComputer(snapshot) : undefined);

  const ownWorker = $derived(
    app.status && app.remote && app.workerId
      ? snapshot?.workers.find((worker) => worker.workerId === app.workerId && worker.installKind === "desktop")
      : undefined,
  );

  const groups = $derived(snapshot ? homes(snapshot) : []);

  const workerGroups = $derived(
    groups
      .map((g) => ({
        ...g,
        workers: listedWorkers(g.home).filter((worker) => g.nodeId || worker.workerId !== ownWorker?.workerId),
      }))
      .filter((g) => g.workers.length),
  );
</script>

{#if snapshot?.computers.length}<UpdateGroupLabel>Computers</UpdateGroupLabel>{/if}
{#if app.status || app.error}<CompactAppUpdate
    updates={app}
    center={updates}
    worker={ownWorker}
    {allowForce}
    bundled={bundled && !app.remote}
  />{/if}
{#if local}<CompactComputerUpdate computer={local} {updates} local />{/if}
{#if snapshot}
  {#if !bundled}<CompactGatewayUpdate {updates} />{@render gateway?.()}{/if}
  {#each snapshot.computers as computer (computer.nodeId)}<CompactComputerUpdate {computer} {updates} />{/each}
  {#if workerGroups.length}<UpdateGroupLabel class="border-t border-divider">Workers</UpdateGroupLabel>{/if}
  {#each workerGroups as group (group.nodeId)}
    {#if workerGroups.length > 1 || group.nodeId}<UpdateGroupLabel class="pt-1 font-normal"
        >{group.name}</UpdateGroupLabel
      >{/if}
    {#each group.workers as worker (worker.workerId)}
      <CompactWorkerUpdate {worker} {updates} home={group.home} nodeId={group.nodeId} {allowForce} />
    {/each}
  {/each}
  <CompactCliSection {groups} {updates} class="border-t" />
{/if}
