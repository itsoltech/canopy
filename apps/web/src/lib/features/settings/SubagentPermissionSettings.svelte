<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { PermissionMode, ui } from "@canopy/contracts";
  import { useSettings } from "./settings-state.svelte.ts";
  import PreferenceRow from "./PreferenceRow.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import FullAccessConfirm from "#lib/features/threads/components/FullAccessConfirm.svelte";
  import { permissionModes } from "#lib/features/threads/labels.ts";

  const settings = useSettings();
  let pending = $state<() => void>();
  const value = $derived(settings.threadDefaults.subagentPermissionMode);

  const save = (subagentPermissionMode: PermissionMode) =>
    settings.updateThreadDefaults(
      create(ui.ThreadDefaultsSchema, { ...settings.threadDefaults, subagentPermissionMode }),
    );
</script>

<SettingsGroup title="Subagents" description="New subagents keep their mode when the parent’s permissions change.">
  <PreferenceRow
    title="Permissions"
    description="A fixed mode can limit access, up to the parent’s current permissions."
    changed={value !== PermissionMode.UNSPECIFIED}
    onreset={() => save(PermissionMode.UNSPECIFIED)}
  >
    {#snippet control()}
      <Select
        aria-label="Subagent permissions"
        value={PermissionMode[value]}
        options={[{ value: "UNSPECIFIED", label: "Same as parent" }, ...permissionModes]}
        onchange={(key) => {
          const selected = permissionModes.find((mode) => mode.value === key);
          const mode = selected ? PermissionMode[selected.value] : PermissionMode.UNSPECIFIED;
          if (mode === PermissionMode.FULL_ACCESS) pending = () => save(mode);
          else void save(mode);
        }}
      />
    {/snippet}
  </PreferenceRow>
</SettingsGroup>
<FullAccessConfirm bind:pending />
