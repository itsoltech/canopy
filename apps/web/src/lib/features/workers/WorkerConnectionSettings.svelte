<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { WorkerSetup } from "./worker-setup.svelte.ts";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";

  let { setup, class: className }: { setup: WorkerSetup; class?: ClassValue } = $props();
  let address = $state("");
  let saving = $state(false);
  let error = $state("");

  $effect(() => {
    address = setup.gatewayUrl;
  });

  async function save() {
    saving = true;
    error = "";

    try {
      await setup.saveAddress(address);
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not save gateway address";
    } finally {
      saving = false;
    }
  }
</script>

<SettingsGroup title="Connection" class={className}>
  <form
    class="grid gap-3 p-4 sm:p-5"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
  >
    <Field
      label="Gateway address for workers"
      description="Leave empty to use Network access automatically. For a different hostname or forwarded port, add it in Network access and enter its HTTPS origin here."
    >
      <Input
        name="public-gateway-address"
        type="url"
        bind:value={address}
        placeholder="Automatic from Network access"
      />
    </Field>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <div class="flex justify-end">
      <Button size="sm" loading={saving} disabled={!setup.loaded} type="submit">Save address</Button>
    </div>
  </form>
</SettingsGroup>
