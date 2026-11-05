<script lang="ts">
  import Select from "#lib/shared/ui/Select.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import type { SelectOption } from "#lib/shared/ui/listbox.ts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import { deviceDefaults, devicePreferences as device, type DeviceKey } from "./device-preferences.svelte.ts";

  let {
    preference,
    title,
    description,
    options,
  }: {
    preference: DeviceKey;
    title: string;
    description: string;
    options: readonly SelectOption[];
  } = $props();
</script>

<PreferenceRow
  {title}
  {description}
  changed={device.values[preference] !== deviceDefaults[preference]}
  onreset={() => device.set(preference, deviceDefaults[preference])}
>
  {#snippet control()}
    {#if options.length === 2 && options.every((option) => option.value === "on" || option.value === "off")}
      <Switch
        name={preference}
        label={title}
        checked={device.values[preference] === "on"}
        onchange={(checked) => device.set(preference, checked ? "on" : "off")}
      />
    {:else}<div class="w-48 max-w-full">
        <Select
          aria-label={title}
          {options}
          value={device.values[preference]}
          onchange={(value) => device.set(preference, value)}
        />
      </div>{/if}
  {/snippet}
</PreferenceRow>
