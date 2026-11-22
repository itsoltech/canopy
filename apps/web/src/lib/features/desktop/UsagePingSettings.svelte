<script lang="ts">
  import { onMount } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let { saving = $bindable(false) }: { saving?: boolean } = $props();
  let available = $state(false);
  let loaded = $state(false);
  let checked = $state(false);
  let error = $state("");
  const label = "Send daily usage ping";

  onMount(() => {
    const bridge = window.canopyDesktop?.usagePing;

    if (!bridge) return;
    available = true;
    void bridge.enabled().then(
      (enabled) => {
        checked = enabled;
        loaded = true;
      },
      () => {
        error = "Could not load the usage ping setting. Restart Canopy to retry.";
      },
    );
  });

  async function change(enabled: boolean) {
    const bridge = window.canopyDesktop?.usagePing;

    if (!bridge || saving) return;
    saving = true;
    error = "";

    try {
      checked = await bridge.setEnabled(enabled);
    } catch {
      checked = !enabled;
      error = "Could not save the usage ping setting. Try again.";
    } finally {
      saving = false;
    }
  }
</script>

{#if available}
  <SettingsGroup title="Privacy">
    <SettingsRow
      title={label}
      description="Canopy sends its version, operating system, CPU architecture, language and screen size to its analytics server to estimate daily use."
    >
      {#snippet control()}
        <Switch {label} name="usage-ping" bind:checked disabled={!loaded || saving} onchange={change} />
      {/snippet}
    </SettingsRow>
    {#if error}<Alert tone="error" banner>{error}</Alert>{/if}
  </SettingsGroup>
{/if}
