<script lang="ts">
  import type { DeviceSessionDefaults } from "@canopy/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let { value = $bindable() }: { value: DeviceSessionDefaults } = $props();
</script>

<div class="grid gap-4 sm:grid-cols-2">
  <Field label="Preferred platform" description="Used when the agent has not selected a device.">
    <Select
      bind:value={value.platform}
      options={[
        { value: "", label: "Any platform" },
        { value: "ios", label: "iOS" },
        { value: "android", label: "Android" },
        { value: "apple", label: "Apple" },
      ]}
    />
  </Field>
  <Field label="Device wait (seconds)" description="Enter 1 to 240 seconds.">
    <Input
      type="number"
      steppers={false}
      min={1}
      max={240}
      step={1}
      placeholder="60"
      bind:value={
        () => value.acquireTimeoutSeconds, (next) => (value.acquireTimeoutSeconds = next == null ? undefined : next)
      }
    />
  </Field>
</div>
<SettingsRow title="Start emulators" description="Allow the agent to start a configured emulator or simulator." flush>
  {#snippet control()}
    <Switch
      name="device-default-boot"
      label="Start emulators"
      checked={value.allowBoot ?? true}
      onchange={(checked) => (value.allowBoot = checked ? undefined : false)}
    />
  {/snippet}
</SettingsRow>
