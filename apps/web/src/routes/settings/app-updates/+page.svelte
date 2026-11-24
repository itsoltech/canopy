<script lang="ts">
  import { onMount } from "svelte";
  import { applicationName } from "#lib/application-name.ts";
  import AppUpdates from "#lib/features/desktop/AppUpdates.svelte";
  import LinkedAppUpdates from "#lib/features/desktop/LinkedAppUpdates.svelte";
  import SettingsTopics from "#lib/features/settings/SettingsTopics.svelte";
  import WhatsNewSettings from "#lib/features/updates/WhatsNewSettings.svelte";
  import { updateCenter } from "#lib/features/workers/updates.svelte.ts";

  onMount(() => updateCenter.poll());
</script>

<svelte:head><title>App updates · Settings · {applicationName}</title></svelte:head>
<AppUpdates>
  {#snippet layout(releases, preferences, hasPreferences)}
    <SettingsTopics
      label="App update settings"
      topics={[
        { id: "releases", label: "Releases", content: currentRelease },
        { id: "preferences", label: "Update preferences", content: preferences, hidden: !hasPreferences },
        {
          id: "computers",
          label: "Linked computers",
          content: computers,
          hidden: !updateCenter.snapshot?.computers.length,
        },
      ]}
    />
    {#snippet currentRelease()}
      {@render releases()}
      <WhatsNewSettings />
    {/snippet}
    {#snippet computers()}
      <LinkedAppUpdates updates={updateCenter} />
    {/snippet}
  {/snippet}
</AppUpdates>
