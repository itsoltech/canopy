<script lang="ts">
  import { onMount } from "svelte";
  import type { QuitShortcut } from "@canopy/ui/desktop";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let saved = $state<QuitShortcut>();
  let choice = $state("");
  let pending = $state(false);
  let error = $state("");
  const options = [
    { value: "press-twice", label: "Press twice", description: "Press again within 1.5 seconds to quit." },
    { value: "hold", label: "Hold", description: "Keep holding the shortcut for 1 second." },
    { value: "immediately", label: "Quit immediately", description: "Quit on the first press." },
  ];
  function receive(value: QuitShortcut) { saved = value; choice = value; }
  onMount(() => {
    const bridge = window.canopyDesktop;
    if (!bridge?.quitShortcut) return;
    const off = bridge.onQuitShortcut(receive);
    void bridge.quitShortcut().then(receive).catch(() => { error = "Quit shortcut settings could not be loaded."; });
    return off;
  });
  async function change(value: string) {
    if (pending || !options.some((option) => option.value === value)) return;
    pending = true; error = "";
    try { receive(await window.canopyDesktop!.setQuitShortcut(value as QuitShortcut)); }
    catch { choice = saved ?? "press-twice"; error = "The quit shortcut could not be saved. Please try again."; }
    finally { pending = false; }
  }
</script>

{#if saved}
  <SettingsGroup title="Desktop shortcuts" description="Choose how the quit shortcut works on this computer.">
    <SettingsRow title="Quit shortcut" description="Menu clicks and system shutdown always quit immediately.">
      {#snippet control()}<div class="w-48"><Select aria-label="Quit shortcut" options={options} bind:value={choice} onchange={change} disabled={pending} /></div>{/snippet}
    </SettingsRow>
  </SettingsGroup>
{/if}
{#if error}<Alert tone="error">{error}</Alert>{/if}
