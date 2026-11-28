<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { applicationName } from "#lib/application-name.ts";
  import AppUpdatePreferences from "#lib/features/desktop/AppUpdatePreferences.svelte";
  import { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import UpdateReleaseNotes from "#lib/features/desktop/UpdateReleaseNotes.svelte";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import WhatsNewSettings from "#lib/features/updates/WhatsNewSettings.svelte";
  import ReleaseChannelField from "#lib/features/workers/ReleaseChannelField.svelte";
  import UpdatesPanel from "#lib/features/workers/UpdatesPanel.svelte";
  import UpdateNotes from "#lib/features/workers/UpdateNotes.svelte";
  import AutoUpdatePreference from "#lib/features/workers/AutoUpdatePreference.svelte";
  import { gatewayRowTarget } from "@canopy/domain/release/update-status";
  import { updateBusy, updateCenter } from "#lib/features/workers/updates.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";

  const app = new DesktopUpdatesState();
  const capabilities = useGatewayCapabilities();
  const gateway = $derived(updateCenter.snapshot);
  const gatewayPreferences = $derived(gateway && !gateway.gatewayBundled);
  const autoUpdate = $derived(gateway?.autoUpdateSupported ?? false);

  const desktopReleases = $derived(
    app.status?.updateVersion && ["downloading", "downloaded", "error"].includes(app.status.phase)
      ? (app.status.releases ?? []).filter((release) => release.markdown.trim())
      : [],
  );

  onMount(() => app.connect());

  $effect(() => {
    if (updateCenter.readable) return untrack(() => updateCenter.poll());
  });
</script>

<svelte:head><title>App updates · Settings · {applicationName}</title></svelte:head>
<SettingsTopics
  label="App update settings"
  topics={[
    {
      id: "status",
      label: "Status",
      keywords: "check for updates update all progress restart gateway workers linked computers",
      content: status,
    },
    {
      id: "preferences",
      label: "Update preferences",
      keywords: "stable beta nightly release channel frequency schedule pinned version automatic auto update",
      content: preferences,
      hidden: !app.status && !gatewayPreferences && !autoUpdate,
    },
    { id: "releases", label: "Releases", keywords: "what's new release notes changelog", content: releases },
  ]}
/>

{#snippet status()}
  {#if !updateCenter.readable}
    <Alert>{capabilities?.message || "Update Canopy on your gateway to see its computers and workers."}</Alert>
  {/if}
  <UpdatesPanel updates={updateCenter} {app} />
{/snippet}

{#snippet preferences()}
  {#if autoUpdate}<AutoUpdatePreference />{/if}
  <AppUpdatePreferences {app} />
  {#if gateway && gatewayPreferences}
    <SettingsGroup title="Gateway">
      <ReleaseChannelField
        current={gateway.channel}
        version={gateway.gatewayVersion}
        disabled={!gateway.admin || updateCenter.active || updateBusy(gateway.gatewayState)}
        pending={updateCenter.pending === "channel"}
        onsave={(channel) => updateCenter.manage({ action: "channel", channel })}
      />
    </SettingsGroup>
    {#if updateCenter.error}<Alert tone="error">{updateCenter.error}</Alert>{/if}
  {/if}
{/snippet}

{#snippet releases()}
  <WhatsNewSettings />
  {#if desktopReleases.length && app.status}
    <UpdateReleaseNotes releases={desktopReleases} title={`What’s new · ${app.status.channel}`} />
  {/if}
  {#if gateway && !gateway.gatewayBundled}
    <UpdateNotes
      current={gateway.gatewayVersion}
      target={gatewayRowTarget(gateway)}
      channel={gateway.channel}
      {desktopReleases}
    />
  {/if}
{/snippet}
