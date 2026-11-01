<script lang="ts">
  import { PermissionMode, type ui } from "@open-agents/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import ModelIdField from "#lib/features/models/ModelIdField.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import { permissionModes, providerLabel } from "../labels.ts";
  import { profilesFor, profileValue, providerKeyOf } from "../providers.ts";

  /**
   * Agent settings of a side thread (form fields `profileId`, `model`, `permissionMode`), pre-filled
   * from `parent`. The provider is the parent's (a fork's history is in that provider's format), so
   * only profiles that can serve it are offered.
   */
  let { worker, parent }: { worker: ui.Worker | undefined; parent: ui.Thread } = $props();
  const provider = $derived(providerLabel(parent.provider));
  const key = $derived(providerKeyOf(parent.provider));
  const profiles = $derived(key ? profilesFor(worker, key) : []);
  // svelte-ignore state_referenced_locally
  let mode = $state<string>(PermissionMode[parent.permissionMode] ?? "ASK");
  // svelte-ignore state_referenced_locally
  let profile = $state(parent.providerProfileId);
  const modeDescription = $derived(permissionModes.find((m) => m.value === mode)?.description);
</script>

<div class="grid gap-4 sm:grid-cols-2">
  <Field
    label="{provider} profile"
    description={profiles.length === 0 ? `The worker reports no profile for ${provider}; its default is used.` : `Side threads run on the main thread's agent (${provider}).`}
  >
    <Select name="profileId" bind:value={profile}>
      {#each profiles as option (option.id)}
        <option value={profileValue(option)}>{option.id}</option>
      {:else}
        <option value="">Default</option>
      {/each}
    </Select>
  </Field>
  <Field label="Model" optional>
    {#if key}<ModelIdField provider={key} label="Model" value={parent.model} />{/if}
  </Field>
</div>
<Field label="Permissions" description={modeDescription}>
  <Select name="permissionMode" bind:value={mode}>
    {#each permissionModes as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
  </Select>
</Field>
