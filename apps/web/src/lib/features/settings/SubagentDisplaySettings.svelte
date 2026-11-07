<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";

  let { class: className }: { class?: ClassValue } = $props();
</script>

<SettingsGroup title="Thread details" description="This device" class={className}>
  <DeviceChoiceRow
    preference="showFinishedSubagents"
    title="Keep finished subagents in the list"
    description="When off, completed, failed and interrupted subagents stay in a separate expandable group."
    options={[
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ]}
  />
</SettingsGroup>
