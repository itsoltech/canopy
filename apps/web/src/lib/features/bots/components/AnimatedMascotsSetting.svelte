<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { setAnimatedMascots, watchAnimatedMascots } from "../animated-mascots.ts";

  let { class: className }: { class?: ClassValue } = $props();
  let enabled = $state(true);
  onMount(() => watchAnimatedMascots((value) => { enabled = value; }));
</script>

<SettingsRow title="Animated mascots" description="Subtle eye tracking and expressions. Saved on this device; respects reduced motion." class={className}>
  {#snippet control()}
    <Switch name="animatedMascots" label="Animated mascots" checked={enabled} onchange={setAnimatedMascots} />
  {/snippet}
</SettingsRow>
