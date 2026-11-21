<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { onMount } from "svelte";
  import type { DesktopStatus } from "@canopy/ui/desktop";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import WorkerStatus from "#lib/features/desktop/WorkerStatus.svelte";

  let status = $state<DesktopStatus>();
  let hasMigration = $state(false);
  let hasMigrationFollowUp = $state(false);
  const local = $derived((status?.configuration?.mode ?? status?.mode) === "local");

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge) return;
    const migration = bridge.gatewayMigration;
    hasMigration = Boolean(migration);
    void migration?.status().then(
      (value) => {
        hasMigrationFollowUp = value.phase === "completed" && Boolean(value.preparation?.selectedPeerIds?.length);
      },
      () => {},
    );
    void bridge.status().then((value) => {
      status = value;
    });

    return bridge.onStatus((value) => {
      status = value;
    });
  });
</script>

<svelte:head><title>Desktop · Settings · {applicationName}</title></svelte:head>
<div class="settings-stack">
  {#if status}
    <WorkerStatus {status} />
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Desktop settings apply only to this computer.
      </p>
    </div>
    <div><Button onclick={() => window.canopyDesktop?.openSettings()}>Change desktop mode…</Button></div>
    {#if local && hasMigration}
      <SettingsGroup>
        <SettingsRow
          href="/desktop/migration"
          title="Migrate gateway"
          description="Move this gateway to a server or bring your history to a shared gateway."
        />
      </SettingsGroup>
    {:else if hasMigrationFollowUp}
      <SettingsGroup>
        <SettingsRow
          href="/desktop/migration"
          title="View migration results"
          description="See which linked computers you chose to follow up with."
        />
      </SettingsGroup>
    {/if}
  {:else}<p class="text-base/6 sm:text-sm/6">Desktop settings are available in the Canopy desktop app.</p>{/if}
</div>
