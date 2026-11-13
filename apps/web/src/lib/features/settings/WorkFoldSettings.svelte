<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import PreferenceRow from "./PreferenceRow.svelte";
  import { deviceDefaults, devicePreferences as device } from "./device-preferences.svelte.ts";

  let { class: className }: { class?: ClassValue } = $props();

  const choices = [
    {
      preference: "workWhileWorking",
      title: "While working",
      description: "Show tool calls, reasoning summaries and progress messages during a turn.",
      options: [
        { value: "expanded", label: "Expanded" },
        { value: "collapsed", label: "Collapsed" },
      ],
    },
    {
      preference: "workToolCalls",
      title: "Tool calls",
      description: "Expand tool groups during a turn.",
      options: [
        { value: "collapsed", label: "Collapsed" },
        { value: "expanded", label: "Expanded" },
      ],
    },
    {
      preference: "workAfterTurn",
      title: "After the turn",
      description: "Collapse when the agent marks the final answer, or when the turn ends.",
      options: [
        { value: "collapse", label: "Collapse" },
        { value: "keep-open", label: "Keep open" },
      ],
    },
  ] as const;
</script>

<SettingsGroup title="Turn activity" description="This device" class={className}>
  {#each choices as choice (choice.preference)}
    <PreferenceRow
      title={choice.title}
      description={choice.description}
      changed={device.values[choice.preference] !== deviceDefaults[choice.preference]}
      onreset={() => device.set(choice.preference, deviceDefaults[choice.preference])}
    >
      {#snippet control()}
        <div class="w-48 max-w-full">
          <Select
            aria-label={choice.title}
            options={choice.options}
            value={device.values[choice.preference]}
            onchange={(value) => device.set(choice.preference, value)}
          />
        </div>
      {/snippet}
    </PreferenceRow>
  {/each}
</SettingsGroup>
