<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";

  let { class: className }: { class?: ClassValue } = $props();
</script>

<SettingsGroup title="Thread details" description="This device" class={className}>
  <DeviceChoiceRow
    preference="showFinishedSubagents"
    title="Show finished subagents"
    description="Include completed, failed and interrupted subagents in thread details."
    options={[
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ]}
  />
</SettingsGroup>
