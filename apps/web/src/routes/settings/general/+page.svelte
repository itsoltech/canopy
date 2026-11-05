<script lang="ts">
  import { ui } from "@canopy/contracts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import { devicePreferences as device, generalDeviceKeys } from "#lib/features/settings/device-preferences.svelte.ts";
  import NotificationSettings from "#lib/features/settings/NotificationSettings.svelte";
  import QuitShortcutSettings from "#lib/features/desktop/QuitShortcutSettings.svelte";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";
  import DeviceChoiceRow from "#lib/features/settings/DeviceChoiceRow.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import SharingGroup from "#lib/features/computers/SharingGroup.svelte";
  import ShareSetting from "#lib/features/computers/ShareSetting.svelte";
  import { sharedKey } from "@canopy/domain/computers";

  const settings = useSettings();
  let desktopSettings = $state<{ resetDefaults(): Promise<void> }>();

  async function restoreDeviceDefaults() {
    device.reset(generalDeviceKeys);
    await desktopSettings?.resetDefaults();
  }

  const confirmations = [
    {
      key: "confirmUnpin",
      title: "Confirm unpin",
      description: "Ask before removing a thread from Pinned.",
      fallback: false,
    },
    {
      key: "confirmArchive",
      title: "Confirm archive",
      description: "Ask before archiving a thread and its side threads.",
      fallback: false,
    },
    {
      key: "confirmDelete",
      title: "Confirm delete",
      description: "Ask before deleting a thread and its side threads.",
      fallback: true,
    },
  ] as const;
</script>

<svelte:head><title>General · Settings · Canopy</title></svelte:head>
<div class="settings-stack">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm/5 text-zinc-500">Account preferences sync through this gateway. “This device” stays here.</p>
    <Button size="sm" icon="arrow-path" onclick={restoreDeviceDefaults}>Restore device defaults</Button>
  </div>
  <NotificationSettings />
  <SettingsGroup title="Sidebar" description="Account">
    <PreferenceRow
      title="Group by project"
      description="Group sidebar threads under project headings."
      changed={settings.sidebar.groupByProject}
      onreset={() => settings.updateSidebar({ groupByProject: false })}
    >
      {#snippet control()}<Switch
          name="groupByProject"
          label="Group by project"
          checked={settings.sidebar.groupByProject}
          onchange={(groupByProject) => settings.updateSidebar({ groupByProject })}
        />{/snippet}
    </PreferenceRow>
    <PreferenceRow
      title="Project order"
      description="Sort project groups by activity, name or creation time."
      changed={settings.sidebar.projectOrder !== ui.ProjectOrder.ACTIVITY}
      onreset={() => settings.updateSidebar({ projectOrder: ui.ProjectOrder.ACTIVITY })}
    >
      {#snippet control()}<div class="w-48">
          <Select
            aria-label="Project order"
            value={String(settings.sidebar.projectOrder)}
            options={[
              { value: "0", label: "Latest activity" },
              { value: "1", label: "Name" },
              { value: "2", label: "Newest project" },
            ]}
            onchange={(value) => settings.updateSidebar({ projectOrder: Number(value) })}
            disabled={!settings.sidebar.groupByProject}
          />
        </div>{/snippet}
    </PreferenceRow>
    <PreferenceRow
      title="Working section"
      description="Group running and monitoring threads in a collapsible section."
      changed={settings.sidebar.workingSection}
      onreset={() => settings.updateSidebar({ workingSection: false })}
    >
      {#snippet control()}<Switch
          name="workingSection"
          label="Working section"
          checked={settings.sidebar.workingSection}
          onchange={(workingSection) => settings.updateSidebar({ workingSection })}
        />{/snippet}
    </PreferenceRow>
  </SettingsGroup>
  <SettingsGroup title="Confirmations" description="Account">
    {#each confirmations as preference (preference.key)}
      {@const value = settings.general[preference.key] ?? preference.fallback}
      <PreferenceRow
        title={preference.title}
        description={preference.description}
        changed={value !== preference.fallback}
        onreset={() => settings.updateGeneral({ [preference.key]: preference.fallback })}
      >
        {#snippet control()}<Switch
            name={preference.key}
            label={preference.title}
            checked={value}
            onchange={(checked) => settings.updateGeneral({ [preference.key]: checked })}
          />{/snippet}
      </PreferenceRow>
    {/each}
  </SettingsGroup>
  <QuitShortcutSettings bind:this={desktopSettings} />
  <SettingsGroup title="Display" description="This device unless marked Account">
    <DeviceChoiceRow
      preference="timeFormat"
      title="Time format"
      description="Set how timestamps show hours."
      options={[
        { value: "system", label: "System" },
        { value: "12h", label: "12-hour" },
        { value: "24h", label: "24-hour" },
      ]}
    />
    <SettingsRow title="Time zone" description="Bots and scheduled tasks use the time zone reported by this device.">
      {#snippet control()}<Badge>Account</Badge>
        <p class="text-sm/6 wrap-anywhere">{settings.user.timezone || "UTC"}</p>{/snippet}
    </SettingsRow>
  </SettingsGroup>
  <SharingGroup><ShareSetting itemKey={sharedKey.settings("timezone")} label="Time zone" /></SharingGroup>
</div>
