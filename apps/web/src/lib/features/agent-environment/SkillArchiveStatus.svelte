<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import { archiveLocation, skillLocation } from "./computer-skills.ts";
  import { archiveOutcome, type SyncComputer } from "./skill-sync.ts";

  let { groups, workers }: { groups: readonly SyncComputer[]; workers: readonly ui.EnvironmentWorker[] } = $props();

  const locations = $derived(
    groups.flatMap(({ worker, files }) =>
      files.map((file) => ({
        file,
        computer: worker.name,
        workerId: worker.workerId,
        status: archiveOutcome(
          workers.find((w) => w.workerId === worker.workerId),
          file,
        ),
      })),
    ),
  );
</script>

<div class="grid gap-2">
  <p role="status">
    {#if locations.some((location) => location.status === "Check this location")}
      Canopy couldn’t confirm every installation. Check the affected locations.
    {:else if locations.every((location) => location.status === "Installed")}
      Installed the Canopy version in {locations.length} {locations.length === 1 ? "location" : "locations"}.
    {:else if locations.some((location) => location.status === "No longer installed")}
      The assignment changed. Check the affected locations.
    {:else}
      Waiting for the computers to confirm installation…
    {/if}
  </p>
  <Disclosure>
    {#snippet summary()}<span class="text-muted">Show recovery locations</span>{/snippet}
    <div class="grid gap-3 pt-2">
      {#each locations as { file, computer, workerId, status } (`${workerId}/${file.archiveToken}/${file.targetId}`)}
        <div>
          <p class="font-medium">{computer} · {skillLocation(file)}</p>
          <p class="text-muted">{status}</p>
          <div class="flex min-w-0 items-start gap-2">
            <span class="min-w-0 flex-1 font-mono text-sm wrap-anywhere select-text">{archiveLocation(file)}</span>
            <CopyButton text={archiveLocation(file)} label="Copy recovery location" />
          </div>
        </div>
      {/each}
    </div>
  </Disclosure>
</div>
