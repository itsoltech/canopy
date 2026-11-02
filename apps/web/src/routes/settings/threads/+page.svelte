<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import ThreadDefaultsFields from "#lib/features/settings/ThreadDefaultsFields.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";

  const overview = useOverview();
  const settings = useSettings();
  const workspaces = $derived(overview.projects.map((project) => ({ project, workspaces: project.workspaces })));
</script>

<svelte:head><title>Threads · Settings · Canopy</title></svelte:head>

<SettingsGroup title="New threads" description="Starting values of the new-thread composer on every device. A project's own defaults take precedence.">
  {#snippet actions()}
    <Button size="sm" icon="arrow-path" onclick={() => settings.updateThreadDefaults(create(ui.ThreadDefaultsSchema))}>Restore defaults</Button>
  {/snippet}
  <ThreadDefaultsFields value={settings.threadDefaults} {workspaces} onchange={(next) => settings.updateThreadDefaults(next)} />
</SettingsGroup>
