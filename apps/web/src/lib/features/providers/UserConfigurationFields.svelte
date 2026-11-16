<script lang="ts">
  import { ProviderConfigurationMode } from "@canopy/contracts";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import { configurationModes, selectConfiguration, type UserConfigurationDraft } from "./user-configuration.ts";

  let {
    value = $bindable(),
    inherited,
    prefix,
  }: {
    value: UserConfigurationDraft | undefined;
    inherited?: UserConfigurationDraft;
    prefix: string;
  } = $props();

  const selection = $derived(
    value ? (configurationModes.find((option) => option.mode === value?.mode)?.value ?? "isolated") : "inherit",
  );

  const inheritedLabel = $derived(configurationModes.find((option) => option.mode === inherited?.mode)?.label);

  const options = $derived([
    ...(inherited ? [{ value: "inherit", label: `Inherit definition (${inheritedLabel})` }] : []),
    ...configurationModes,
  ]);

  const description = $derived(
    !value
      ? "Uses the definition's configuration, including its source directory."
      : value.mode === ProviderConfigurationMode.LOCAL
        ? "Uses local settings and preferences while keeping thread history private."
        : value.mode === ProviderConfigurationMode.SHARED
          ? "Shares thread history with Claude Code in the source directory."
          : "Keeps Claude's settings and thread history in Canopy's private directory.",
  );
</script>

<div class="settings-form">
  <Field layout="row" label="User configuration" {description}>
    <Select
      name="{prefix}-configuration"
      value={selection}
      {options}
      onchange={(selected) => (value = selectConfiguration(selected, value ?? inherited))}
    />
  </Field>
  {#if value && value.mode !== ProviderConfigurationMode.ISOLATED}
    <Field
      layout="row"
      label="Configuration source"
      description="Empty uses the worker's detected Claude configuration directory."
    >
      <Input
        name="{prefix}-configuration-source"
        bind:value={value.sourcePath}
        placeholder="~/.claude"
        autocomplete="off"
        spellcheck="false"
        class="font-mono"
      />
    </Field>
    <div class="grid gap-2 py-2">
      <Checkbox name="{prefix}-instructions" label="Global instructions" bind:checked={value.instructions} />
      <Checkbox name="{prefix}-skills" label="Personal skills" bind:checked={value.skills} />
      <Checkbox
        name="{prefix}-hooks"
        label="Hooks"
        description="Runs commands from your local Claude settings."
        bind:checked={value.hooks}
      />
      <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
        Canopy controls permissions and connected tools.
      </p>
    </div>
  {/if}
</div>
