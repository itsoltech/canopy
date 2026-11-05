<script lang="ts">
  import { onMount } from "svelte";
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";
  import type { QuitShortcut } from "@canopy/ui/desktop";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import PreferenceRow from "#lib/features/settings/PreferenceRow.svelte";

  let saved = $state<QuitShortcut>();
  let choice = $state("");
  let pending = $state(false);
  let error = $state("");

  const options = [
    { value: "press-twice", label: "Press twice", description: "Press twice within 500 ms to quit." },
    {
      value: "hold",
      label: "Hold",
      description: "Hold for 1 second, or press twice if key repeat is unavailable.",
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
        error = "Could not load the quit shortcut setting. Restart Canopy to retry.";
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

  export async function resetDefaults(): Promise<void> {
    if (saved) await change("press-twice");
  }
</script>

{#if saved}
  <SettingsGroup title="Desktop app" description="This device">
    <PreferenceRow
      title="Quit shortcut"
      description="Set how the keyboard shortcut closes Canopy."
      changed={choice !== "press-twice"}
      onreset={() => change("press-twice")}
    >
      {#snippet control()}<div class="w-48">
          <Select aria-label="Quit shortcut" {options} bind:value={choice} onchange={change} disabled={pending} />
        </div>{/snippet}
    </PreferenceRow>
  </SettingsGroup>
{/if}
{#if error}<Alert tone="error">{error}</Alert>{/if}
