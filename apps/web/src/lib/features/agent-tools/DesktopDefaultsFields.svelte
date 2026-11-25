<script lang="ts">
  import type { DesktopSessionDefaults } from "@canopy/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let { value = $bindable() }: { value: DesktopSessionDefaults } = $props();
</script>

<Field
  label="Default app"
  description="Used when no app or window is selected. Screen size follows the app or display."
>
  <Input bind:value={value.app} maxlength={200} placeholder="Safari" />
</Field>
<SettingsRow
  title="Allow physical input"
  description="In later turns, Agent Desktop can move your pointer, change window focus and send keystrokes on workers where it’s enabled."
  flush
>
  {#snippet control()}
    <Switch
      name="desktop-default-physical-input"
      label="Allow physical input"
      bind:checked={value.allowPhysicalInput}
    />
  {/snippet}
</SettingsRow>
