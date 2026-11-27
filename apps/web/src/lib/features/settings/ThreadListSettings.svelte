<script lang="ts">
  import { ui } from "@canopy/contracts";
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { devicePreferences as device } from "./device-preferences.svelte.ts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import { useSettings } from "./settings-state.svelte.ts";

  const settings = useSettings();

  const groupBy = $derived(
    !settings.sidebar.groupByProject ? "none" : device.view.groupByWorktree ? "project-worktree" : "project",
  );

  function setGrouping(value: string) {
    device.setView({ groupByProject: value !== "none", groupByWorktree: value === "project-worktree" });
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

  function threadListNotice({ kind, field }: ui.ConfigNotice) {
    const [section] = field.split(".");

    return (
      kind === "settings" && (section === "general" || (section === "sidebar" && field !== "sidebar.pinnedBotIds"))
    );
  }
</script>

<SettingsGroup title="Sidebar" description="This device">
  <PreferenceRow title="Group by" changed={groupBy !== "none"} onreset={() => setGrouping("none")}>
    {#snippet control()}<div class="w-48 max-w-full">
        <Select
          aria-label="Group by"
          value={groupBy}
          options={[
            { value: "none", label: "None" },
            { value: "project", label: "Project" },
            { value: "project-worktree", label: "Project & worktree" },
          ]}
          onchange={setGrouping}
        />
      </div>{/snippet}
  </PreferenceRow>
  <PreferenceRow
    title="Project order"
    description="Sort project groups by activity, name or creation time."
    changed={settings.sidebar.projectOrder !== ui.ProjectOrder.ACTIVITY}
    onreset={() => settings.updateSidebar({ projectOrder: ui.ProjectOrder.ACTIVITY })}
  >
    {#snippet control()}<div class="w-48 max-w-full">
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
  <PreferenceRow
    title="Working section position"
    changed={device.view.workingSectionPosition !== "bottom"}
    onreset={() => device.setView({ workingSectionPosition: "bottom" })}
  >
    {#snippet control()}<div class="w-48 max-w-full">
        <Select
          aria-label="Working section position"
          value={device.view.workingSectionPosition}
          options={[
            { value: "top", label: "Top" },
            { value: "bottom", label: "Bottom" },
          ]}
          onchange={(value) => device.setView({ workingSectionPosition: value === "top" ? "top" : "bottom" })}
          disabled={!settings.sidebar.workingSection}
        />
      </div>{/snippet}
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
<ConfigNotices match={threadListNotice} />
