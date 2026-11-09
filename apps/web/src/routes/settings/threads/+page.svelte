<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import ThreadDefaultsFields from "#lib/features/settings/ThreadDefaultsFields.svelte";
  import AccountConfigNotices from "#lib/features/computers/AccountConfigNotices.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SubagentDisplaySettings from "#lib/features/settings/SubagentDisplaySettings.svelte";
  import WorkFoldSettings from "#lib/features/settings/WorkFoldSettings.svelte";
  import FollowUpSettings from "#lib/features/settings/FollowUpSettings.svelte";

  const overview = useOverview();
  const settings = useSettings();
  const workspaces = $derived(overview.ownProjects.map((project) => ({ project, workspaces: project.workspaces })));
</script>

<svelte:head><title>Threads · Settings · Canopy</title></svelte:head>

<SubagentDisplaySettings />
<WorkFoldSettings />
<FollowUpSettings />

<SettingsGroup
  title="New threads"
  description="Defaults for new threads on all your computers and devices. Project defaults override them."
>
  {#snippet actions()}
    <Button size="sm" icon="arrow-path" onclick={() => settings.updateThreadDefaults(create(ui.ThreadDefaultsSchema))}
      >Restore defaults</Button
    >
  {/snippet}
  <ThreadDefaultsFields
    value={settings.threadDefaults}
    {workspaces}
    onchange={(next) => settings.updateThreadDefaults(next)}
  />
</SettingsGroup>

<AccountConfigNotices section="threadDefaults" />
<AccountConfigNotices section="composer" />
