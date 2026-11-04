<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { setAnimatedMascots, watchAnimatedMascots } from "../animated-mascots.ts";

  let { class: className }: { class?: ClassValue } = $props();
  let enabled = $state(true);

  onMount(() =>
    watchAnimatedMascots((value) => {
      enabled = value;
    }),
  );
</script>

<PreferenceRow
  title="Animated mascots"
  description="Animate mascot eyes and expressions when reduced motion is off."
  class={className}
  changed={!enabled}
  onreset={() => setAnimatedMascots(true)}
>
  {#snippet control()}
    <Switch name="animatedMascots" label="Animated mascots" checked={enabled} onchange={setAnimatedMascots} />
  {/snippet}
</PreferenceRow>
