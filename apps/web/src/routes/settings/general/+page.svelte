<script lang="ts">
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import { applicationName } from "#lib/application-name.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import ModuleSettings from "#lib/features/settings/ModuleSettings.svelte";
  import QuitShortcutSettings from "#lib/features/desktop/QuitShortcutSettings.svelte";
  import DeviceChoiceRow from "#lib/features/settings/DeviceChoiceRow.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import AccountConfigNotices from "#lib/features/computers/AccountConfigNotices.svelte";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";

  const settings = useSettings();
  let desktopSettings = $state<{ resetDefaults(): Promise<void> }>();

  async function restoreDeviceDefaults() {
    device.reset(["timeFormat"]);
    await desktopSettings?.resetDefaults();
  }
</script>

<svelte:head><title>General · Settings · {applicationName}</title></svelte:head>

<SettingsTopics
  label="General settings"
  topics={[
    { id: "modules", label: "Modules", content: modules, hidden: !settings.user.modules },
    { id: "device", label: "Device", content: deviceSettings },
  ]}
/>
<AccountConfigNotices section={settings.moduleEnabled("threads") ? "sidebar.pinnedBotIds" : "sidebar"} />
{#if !settings.moduleEnabled("threads")}<AccountConfigNotices section="general" />{/if}
{#if !settings.user.modules}<AccountConfigNotices section="modules" />{/if}

{#snippet modules()}
  <ModuleSettings />
  <AccountConfigNotices section="modules" />
{/snippet}

{#snippet deviceSettings()}
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm/5 text-zinc-500">
      Account preferences follow your configuration group. “This device” stays here.
    </p>
    <Button size="sm" icon="arrow-path" onclick={restoreDeviceDefaults}>Restore device defaults</Button>
  </div>
  <QuitShortcutSettings bind:this={desktopSettings} />
  <SettingsGroup title="Time" description="This device unless marked Account">
    <DeviceChoiceRow
      preference="timeFormat"
      title="Time format"
      options={[
        { value: "system", label: "System" },
        { value: "12h", label: "12-hour" },
        { value: "24h", label: "24-hour" },
      ]}
    />
    <SettingsRow title="Time zone" description="Canopy uses this device’s time zone when scheduling work.">
      {#snippet control()}<Badge>Account</Badge>
        <p class="text-sm/6 wrap-anywhere">{settings.user.timezone || "UTC"}</p>{/snippet}
    </SettingsRow>
  </SettingsGroup>
  <AccountConfigNotices section="timezone" />
{/snippet}
