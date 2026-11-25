<script lang="ts">
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import { applicationName } from "#lib/application-name.ts";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import ThreadDefaultsFields from "#lib/features/settings/ThreadDefaultsFields.svelte";
  import AccountConfigNotices from "#lib/features/computers/AccountConfigNotices.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SubagentDisplaySettings from "#lib/features/settings/SubagentDisplaySettings.svelte";
  import WorkFoldSettings from "#lib/features/settings/WorkFoldSettings.svelte";
  import FollowUpSettings from "#lib/features/settings/FollowUpSettings.svelte";
  import SandboxProfilesSettings from "#lib/features/settings/SandboxProfilesSettings.svelte";
  import SubagentPermissionSettings from "#lib/features/settings/SubagentPermissionSettings.svelte";
  import ThreadRetentionSettings from "#lib/features/settings/ThreadRetentionSettings.svelte";
  import AutoArchiveSettings from "#lib/features/settings/AutoArchiveSettings.svelte";
  import GitHubThreadNotifications from "#lib/features/settings/GitHubThreadNotifications.svelte";

  const route = useSettingsRoute();
  const overview = useOverview();
  const settings = useSettings();
  const workspaces = $derived(overview.ownProjects.map((project) => ({ project, workspaces: project.workspaces })));
</script>

<svelte:head><title>Threads · Settings · {applicationName}</title></svelte:head>

<SettingsTopics
  label="Thread settings"
  defaultTopic={route.url.hash === "#sandbox-profiles" ? "permissions" : undefined}
  topics={[
    { id: "new-threads", label: "New threads", content: newThreads },
    { id: "conversation", label: "Conversation", content: conversation },
    { id: "permissions", label: "Sandbox and subagents", content: permissions },
    { id: "archiving", label: "Archiving", keywords: "retention cleanup", content: archiving },
  ]}
/>

{#snippet newThreads()}
  <SettingsGroup
    title="New threads"
    description="Defaults for new threads on all your computers and devices. Project defaults override them."
  >
    {#snippet actions()}
      <Button
        size="sm"
        icon="arrow-path"
        onclick={() =>
          settings.updateThreadDefaults(
            create(ui.ThreadDefaultsSchema, {
              subagentPermissionMode: settings.threadDefaults.subagentPermissionMode,
              autoArchiveOnMerge: settings.threadDefaults.autoArchiveOnMerge,
              notifyOnLinkedPullRequests: settings.threadDefaults.notifyOnLinkedPullRequests,
            }),
          )}>Restore defaults</Button
      >
    {/snippet}
    <ThreadDefaultsFields
      value={settings.threadDefaults}
      {workspaces}
      onchange={(next) => settings.updateThreadDefaults(next)}
    />
  </SettingsGroup>
{/snippet}

{#snippet conversation()}
  <FollowUpSettings />
  <WorkFoldSettings />
  <SubagentDisplaySettings />
  <GitHubThreadNotifications />
  <AccountConfigNotices section="composer" />
{/snippet}

{#snippet permissions()}
  <SubagentPermissionSettings />
  <SandboxProfilesSettings />
{/snippet}

{#snippet archiving()}
  <AutoArchiveSettings />
  <ThreadRetentionSettings />
  <AccountConfigNotices section="threadRetention" />
{/snippet}

<AccountConfigNotices section="threadDefaults" />
