<script lang="ts">
  import Select from "#lib/shared/ui/Select.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import OptionTile from "#lib/shared/ui/OptionTile.svelte";
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
    {:else if options.length === 2}
      <div class="grid w-72 max-w-full grid-cols-2 gap-2" role="radiogroup" aria-label={title}>
        {#each options as option (option.value)}
          <OptionTile
            label={option.label}
            checked={device.values[preference] === option.value}
            onchange={() => device.set(preference, option.value)}
            class="py-2 pr-8 pl-3 text-sm">{option.label}</OptionTile
          >
        {/each}
      </div>
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
