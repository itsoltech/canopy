<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useSettings } from "./settings-state.svelte.ts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let { projectId, class: className }: { projectId?: string; class?: ClassValue } = $props();

  const settings = useSettings();
  const defaults = $derived(projectId ? settings.projectDefaults(projectId) : settings.threadDefaults);
  const inherited = $derived(settings.threadDefaults.autoArchiveOnMerge ?? false);
  const value = $derived(defaults.autoArchiveOnMerge);

  function set(autoArchiveOnMerge: boolean | undefined) {
    const next = create(ui.ThreadDefaultsSchema, { ...defaults, autoArchiveOnMerge });

    if (projectId) void settings.updateProjectDefaults(projectId, next);
    else void settings.updateThreadDefaults(next);
  }
</script>

<SettingsGroup
  title="Pull requests"
  description="Archive after all linked pull requests merge and the thread finishes working."
  class={className}
>
  <PreferenceRow
    title="Auto-archive after merge"
    description={projectId
      ? "Applies to existing and new threads in this project, unless a thread overrides it."
      : "Applies to existing and new threads, unless a project or thread overrides it."}
    changed={projectId ? value !== undefined : !!value}
    onreset={() => set(undefined)}
  >
    {#snippet control()}
      {#if projectId}
        <Select
          name="autoArchiveOnMerge"
          aria-label="Auto-archive after merge"
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
          name="autoArchiveOnMerge"
          label="Auto-archive after merge"
          checked={value ?? false}
          disabled={!settings.loaded}
          onchange={set}
        />
      {/if}
    {/snippet}
  </PreferenceRow>
</SettingsGroup>
