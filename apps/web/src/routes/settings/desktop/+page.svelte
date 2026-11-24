<script lang="ts">
  import { applicationName } from "#lib/application-name.ts";
  import { onMount } from "svelte";
  import type { DesktopStatus } from "@canopy/ui/desktop";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import WorkerStatus from "#lib/features/desktop/WorkerStatus.svelte";
  import UsagePingSettings from "#lib/features/desktop/UsagePingSettings.svelte";

  let status = $state<DesktopStatus>();
  let hasUsagePing = $state(false);
  let hasMigration = $state(false);
  let hasMigrationFollowUp = $state(false);
  const local = $derived((status?.configuration?.mode ?? status?.mode) === "local");

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge) return;
    hasUsagePing = Boolean(bridge.usagePing);
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
{#if status}
  {@const current = status}
  <SettingsTopics
    label="Desktop settings"
    topics={[
      { id: "gateway", label: "Gateway", content: gateway },
      { id: "privacy", label: "Privacy", content: privacy, hidden: !hasUsagePing },
    ]}
  />
  {#snippet gateway()}
    <SettingsGroup title="This computer">
      <WorkerStatus status={current} class="p-4" />
      <SettingsRow title="Desktop mode">
        {#snippet control()}<Button size="sm" onclick={() => window.canopyDesktop?.openSettings()}>Change mode…</Button
          >{/snippet}
      </SettingsRow>
    </SettingsGroup>
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
  {/snippet}
  {#snippet privacy()}
    <UsagePingSettings />
  {/snippet}
{:else}
  <p class="text-base/6 sm:text-sm/6">Desktop settings are available in the Canopy desktop app.</p>
{/if}
