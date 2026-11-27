<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { useSettings } from "#lib/features/settings/settings-state.svelte.ts";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  /** Opt-in: the gateway starts Update all by itself once its owner's work is quiet (docs/updates.md). */
  let { class: className }: { class?: ClassValue } = $props();
  const settings = useSettings();
  const enabled = $derived(settings.user.appUpdates?.autoUpdate ?? false);
  const change = (autoUpdate: boolean) => void settings.updateAutoUpdate(autoUpdate);
</script>

<SettingsGroup title="Update all" description="Computers and workers on this gateway" class={className}>
  <PreferenceRow
    title="Automatic updates"
    description="Canopy runs Update all after no turn or background task has run for 5 minutes."
    changed={enabled}
    onreset={() => change(false)}
  >
    {#snippet control()}
      <Switch name="autoUpdate" label="Automatic updates" checked={enabled} onchange={change} />
    {/snippet}
    {#if enabled}<p class="mt-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
        Computers restart without asking first.
      </p>{/if}
  </PreferenceRow>
</SettingsGroup>
