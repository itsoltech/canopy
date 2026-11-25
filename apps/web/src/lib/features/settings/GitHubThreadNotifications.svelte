<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import { useSettings } from "./settings-state.svelte.ts";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let { projectId }: { projectId?: string } = $props();

  const title = "Notify agent about pull requests";
  const settings = useSettings();
  const defaults = $derived(projectId ? settings.projectDefaults(projectId) : settings.threadDefaults);
  const inherited = $derived(settings.threadDefaults.notifyOnLinkedPullRequests ?? true);
  const value = $derived(defaults.notifyOnLinkedPullRequests);

  function set(notifyOnLinkedPullRequests: boolean | undefined) {
    const next = create(ui.ThreadDefaultsSchema, { ...defaults, notifyOnLinkedPullRequests });

    if (projectId) void settings.updateProjectDefaults(projectId, next);
    else void settings.updateThreadDefaults(next);
  }
</script>

<SettingsGroup title="GitHub notifications">
  <PreferenceRow
    {title}
    description="Send merge conflicts and final check results to the agent in the linked thread."
    changed={projectId ? value !== undefined : value === false}
    resetLabel="Reset pull request notifications to default"
    onreset={() => set(undefined)}
  >
    {#snippet control()}
      {#if projectId}
        <Select
          name="notifyOnLinkedPullRequests"
          aria-label={title}
          class="w-56 sm:w-64"
          disabled={!settings.loaded}
          value={value === undefined ? "inherit" : value ? "on" : "off"}
          options={[
            { value: "inherit", label: `Use my default (${inherited ? "on" : "off"})` },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onchange={(choice) => set(choice === "inherit" ? undefined : choice === "on")}
        />
      {:else}
        <Switch
          name="notifyOnLinkedPullRequests"
          label={title}
          checked={value ?? true}
          disabled={!settings.loaded}
          onchange={set}
        />
      {/if}
    {/snippet}
  </PreferenceRow>
</SettingsGroup>
