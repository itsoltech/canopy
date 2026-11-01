<script lang="ts">
  import { PermissionMode, type ui } from "@open-agents/contracts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import { permissionModes } from "../labels.ts";

  /**
   * Agent settings of a new thread (form fields `profileId`, `model`, `permissionMode`).
   * `defaults` pre-fills them, e.g. from the parent of a side thread.
   */
  let { worker, defaults }: { worker: ui.Worker | undefined; defaults?: ui.Thread | undefined } = $props();
  const profiles = $derived(worker?.profiles.filter((p) => p.available) ?? []);
  // svelte-ignore state_referenced_locally
  let mode = $state<string>(defaults ? (PermissionMode[defaults.permissionMode] ?? "ASK") : "ASK");
  // svelte-ignore state_referenced_locally
  let profile = $state(defaults?.providerProfileId ?? "");
  const modeDescription = $derived(permissionModes.find((m) => m.value === mode)?.description);
</script>

<div class="grid gap-4 sm:grid-cols-2">
  <Field label="Codex profile" description={profiles.length === 0 ? "The worker reports no available profile; its default is used." : undefined}>
    <Select name="profileId" bind:value={profile}>
      {#each profiles as option (option.id)}
        <option value={option.id === "native" ? "" : option.id}>{option.id}</option>
      {:else}
        <option value="">Default</option>
      {/each}
    </Select>
  </Field>
  <Field label="Model" optional>
    <Input name="model" placeholder="Profile default" autocomplete="off" value={defaults?.model ?? ""} />
  </Field>
</div>
<Field label="Permissions" description={modeDescription}>
  <Select name="permissionMode" bind:value={mode}>
    {#each permissionModes as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
  </Select>
</Field>
