<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useSettings } from "./settings-state.svelte.ts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  const settings = useSettings();
</script>

<SettingsGroup title="Messages" class={className}>
  <PreferenceRow
    class="[&_.settings-row-copy_p]:whitespace-normal"
    title="When the agent is working, send messages as"
    description="Steer joins the current turn, while Queue waits for the next turn."
    changed={settings.runningDelivery === "queue"}
    onreset={() => settings.updateRunningDelivery("steer")}
  >
    {#snippet control()}
      <Select
        name="runningDelivery"
        aria-label="When the agent is working, send messages as"
        value={settings.runningDelivery}
        onchange={(value) => settings.updateRunningDelivery(value === "queue" ? "queue" : "steer")}
        class="w-56 sm:w-48"
        options={[
          { value: "steer", label: "Steer" },
          { value: "queue", label: "Queue" },
        ]}
      />
    {/snippet}
  </PreferenceRow>
</SettingsGroup>
