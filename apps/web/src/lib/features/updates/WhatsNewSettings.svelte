<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { whatsNew as notes } from "./whats-new.svelte.ts";

  let { class: className }: { class?: ClassValue } = $props();
</script>

<SettingsGroup title="What's new" class={className}>
  <SettingsRow
    title={`Canopy ${notes.current}`}
    description={notes.previous ? `Updated from ${notes.previous}.` : undefined}
  >
    {#snippet control()}<Button size="sm" onclick={() => notes.show()}>See what's new</Button>{/snippet}
  </SettingsRow>
</SettingsGroup>
