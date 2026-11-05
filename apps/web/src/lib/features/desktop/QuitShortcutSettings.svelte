<script lang="ts">
  import { onMount } from "svelte";
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";
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
    { value: "press-twice", label: "Press twice", description: "Press twice within 500 ms to quit." },
    {
      value: "hold",
      label: "Hold",
      description: "Hold for at least 1 second. Requires key repeat; otherwise press twice.",
    },
    { value: "immediately", label: "Quit immediately", description: "Quit on the first press." },
  ] as const satisfies readonly SelectOption[];

  function receive(value: QuitShortcut) {
    saved = value;
    choice = value;
  }

  onMount(() => {
    const bridge = window.canopyDesktop;

    if (!bridge?.quitShortcut) return;
    const off = bridge.onQuitShortcut(receive);
    void bridge
      .quitShortcut()
      .then(receive)
      .catch(() => {
        error = "Could not load the quit shortcut setting.";
      });

    return off;
  });

  async function change(value: string) {
    const option = options.find((candidate) => candidate.value === value);

    if (pending || !option) return;
    pending = true;
    error = "";

    try {
      receive(await window.canopyDesktop!.setQuitShortcut(option.value));
    } catch {
      choice = saved ?? "press-twice";
      error = "Could not save the quit shortcut. Try again.";
    } finally {
      pending = false;
    }
  }
</script>

{#if saved}
  <SettingsGroup title="Desktop shortcuts" description="Choose how the quit shortcut works on this computer.">
    <SettingsRow title="Quit shortcut" description="Menu clicks and system shutdown always quit immediately.">
      {#snippet control()}<div class="w-48">
          <Select aria-label="Quit shortcut" {options} bind:value={choice} onchange={change} disabled={pending} />
        </div>{/snippet}
    </SettingsRow>
  </SettingsGroup>
{/if}
{#if error}<Alert tone="error">{error}</Alert>{/if}
